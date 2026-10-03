import { strFromU8, unzipSync } from "fflate";
import type { SongData, SongEntry } from "./song";

/**
 * Songs kept on this device. Audio never leaves the phone: it is read from a file the
 * user picks and stored in IndexedDB, so the deployed site itself carries no music.
 */
export type StoredSong = { meta: SongData; backing: ArrayBuffer; vocals: ArrayBuffer | null };

const DB_NAME = "songfixer";
// The list is kept apart from the audio so showing it does not read megabytes per song.
const LIST = "list";
const DATA = "data";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(LIST, { keyPath: "id" });
      req.result.createObjectStore(DATA, { keyPath: "meta.id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const req = body(tx);
    tx.oncomplete = () => { db.close(); resolve(req ? req.result : undefined); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

export async function listLocal(): Promise<SongEntry[]> {
  const all = await run<SongEntry[]>([LIST], "readonly", (tx) => tx.objectStore(LIST).getAll());
  return all ?? [];
}

export async function readLocal(id: string): Promise<StoredSong> {
  const s = await run<StoredSong>([DATA], "readonly", (tx) => tx.objectStore(DATA).get(id));
  if (!s) throw new Error(`${id} がこの端末にありません`);
  return s;
}

export async function removeLocal(id: string): Promise<void> {
  await run([LIST, DATA], "readwrite", (tx) => {
    tx.objectStore(LIST).delete(id);
    tx.objectStore(DATA).delete(id);
  });
}

async function save(s: StoredSong): Promise<void> {
  const { id, title, artist } = s.meta;
  await run([LIST, DATA], "readwrite", (tx) => {
    tx.objectStore(LIST).put({ id, title, artist });
    tx.objectStore(DATA).put(s);
  });
  // Without this the browser may clear the songs when the phone runs low on space.
  try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
}

const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1).toLowerCase();
const copy = (u: Uint8Array) => u.slice().buffer;

/**
 * Stores a song from a pack made by tools/pack_song.py, or from its three files picked
 * together (song.json, backing.mp3 and optionally vocals.mp3).
 */
export async function importFiles(files: File[]): Promise<SongEntry> {
  const parts = new Map<string, Uint8Array>();
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (basename(f.name).endsWith(".zip")) {
      for (const [name, data] of Object.entries(unzipSync(bytes))) if (data.length) parts.set(basename(name), data);
    } else {
      parts.set(basename(f.name), bytes);
    }
  }
  const json = parts.get("song.json");
  const backing = parts.get("backing.mp3");
  if (!json || !backing) throw new Error("song.json と backing.mp3 が見つかりません");
  const meta = JSON.parse(strFromU8(json)) as SongData;
  if (!meta.id || !Array.isArray(meta.notes) || !meta.duration) throw new Error("song.json の形式が違います");
  const vocals = parts.get("vocals.mp3");
  await save({ meta, backing: copy(backing), vocals: vocals ? copy(vocals) : null });
  return { id: meta.id, title: meta.title, artist: meta.artist };
}
