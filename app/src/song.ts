import type { Target } from "./lesson";
import { centsOff, foldToward } from "./notes";

export type Note = { t: number; d: number; m: number };
export type SongEntry = { id: string; title: string; artist: string };
export type SongData = SongEntry & {
  duration: number;
  notes: Note[];
  pitch: { hop: number; midi: (number | null)[] };
};
export type LoadedSong = SongData & { backing: AudioBuffer; vocals: AudioBuffer | null };

async function buffer(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} が読めません`);
  return ctx.decodeAudioData(await r.arrayBuffer());
}

export async function loadIndex(): Promise<SongEntry[]> {
  const r = await fetch("songs/index.json");
  if (!r.ok) return [];
  return r.json();
}

export async function loadSong(ctx: AudioContext, id: string): Promise<LoadedSong> {
  const [meta, backing, vocals] = await Promise.all([
    fetch(`songs/${id}/song.json`).then((r) => r.json() as Promise<SongData>),
    buffer(ctx, `songs/${id}/backing.mp3`),
    buffer(ctx, `songs/${id}/vocals.mp3`).catch(() => null),
  ]);
  return { ...meta, backing, vocals };
}

/**
 * Plays the karaoke track (and optionally the guide vocal) and reports where in the
 * song we are. Time is kept in song seconds, derived from the AudioContext clock so
 * that scoring lines up with what is actually coming out of the speakers.
 */
export class SongPlayer {
  private backingSrc?: AudioBufferSourceNode;
  private vocalSrc?: AudioBufferSourceNode;
  private backingGain: GainNode;
  private vocalGain: GainNode;
  /** The guide vocal at full level, for analysing the app against its own reference. */
  readonly tap: GainNode;
  private anchorCtx = 0;
  private anchorSong = 0;
  private paused = 0;
  playing = false;
  /** Playback speed. Doubles as the key change: 2**(semitones/12). */
  rate = 1;
  loop: { a: number; b: number } | null = null;

  constructor(private ctx: AudioContext, readonly song: LoadedSong) {
    this.backingGain = ctx.createGain();
    this.vocalGain = ctx.createGain();
    this.tap = ctx.createGain();
    this.backingGain.connect(ctx.destination);
    this.tap.connect(this.vocalGain);
    this.vocalGain.connect(ctx.destination);
    this.vocalGain.gain.value = 0;
  }

  set guide(v: number) { this.vocalGain.gain.value = v; }
  set volume(v: number) { this.backingGain.gain.value = v; }

  private play(buf: AudioBuffer, out: GainNode, when: number, offset: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = this.rate;
    if (this.loop) {
      src.loop = true;
      src.loopStart = this.loop.a;
      src.loopEnd = this.loop.b;
    }
    src.connect(out);
    src.start(when, offset);
    return src;
  }

  start(from = this.paused) {
    this.stop();
    const { a, b } = this.loop ?? { a: 0, b: this.song.duration };
    const offset = from >= a && from < b ? from : a;
    const when = this.ctx.currentTime + 0.08;
    this.backingSrc = this.play(this.song.backing, this.backingGain, when, offset);
    if (this.song.vocals) this.vocalSrc = this.play(this.song.vocals, this.tap, when, offset);
    this.anchorCtx = when;
    this.anchorSong = offset;
    this.playing = true;
  }

  stop() {
    if (this.playing) this.paused = this.time();
    for (const s of [this.backingSrc, this.vocalSrc]) { try { s?.stop(); } catch { /* not started */ } }
    this.backingSrc = this.vocalSrc = undefined;
    this.playing = false;
  }

  seek(t: number) {
    this.paused = Math.max(0, Math.min(this.song.duration, t));
    if (this.playing) this.start(this.paused);
  }

  /** Re-apply rate or loop points; a running source cannot change them cleanly. */
  refresh() {
    if (this.playing) this.start(this.time());
  }

  time(): number {
    if (!this.playing) return this.paused;
    const raw = this.anchorSong + (this.ctx.currentTime - this.anchorCtx) * this.rate;
    if (!this.loop) return Math.min(raw, this.song.duration);
    const len = this.loop.b - this.loop.a;
    return this.loop.a + (((raw - this.loop.a) % len) + len) % len;
  }

  /** True once a non-looping play has run off the end. */
  get ended(): boolean {
    return this.playing && !this.loop && this.time() >= this.song.duration;
  }
}

export type PhraseScore = { note: Note; voiced: number; hit: number; meanCents: number };

/** Scores the voice against the reference melody, one microphone frame at a time. */
export class SongScorer {
  private stats = new Map<number, { frames: number; voiced: number; hit: number; cents: number }>();

  constructor(
    private notes: Note[],
    public toleranceCents: number,
    public octaveFree: boolean,
    /** Semitones the backing (and so the reference melody) was shifted by. */
    public keyShift = 0,
  ) {}

  /** Index of the note sounding at song time t, or -1. Notes are in order. */
  private at(t: number): number {
    let lo = 0, hi = this.notes.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const n = this.notes[mid];
      if (t < n.t) hi = mid - 1;
      else if (t >= n.t + n.d) lo = mid + 1;
      else return mid;
    }
    return -1;
  }

  targets(): Target[] {
    return this.notes.map((n) => ({ midi: n.m + this.keyShift, start: n.t, end: n.t + n.d, kind: "sing" as const }));
  }

  feed(t: number, midi: number | null): { display: number | null; judge?: boolean; cents?: number } {
    const i = this.at(t);
    if (i < 0) return { display: midi };
    const target = this.notes[i].m + this.keyShift;
    let s = this.stats.get(i);
    if (!s) this.stats.set(i, (s = { frames: 0, voiced: 0, hit: 0, cents: 0 }));
    s.frames++;
    if (midi === null) return { display: null };
    const cents = centsOff(midi, target, this.octaveFree);
    const judge = Math.abs(cents) <= this.toleranceCents;
    s.voiced++;
    s.cents += cents;
    if (judge) s.hit++;
    return { display: this.octaveFree ? foldToward(midi, target) : midi, judge, cents };
  }

  reset() { this.stats.clear(); }

  /** 0-100 over the notes attempted so far, or null if nothing was sung yet. */
  score(): number | null {
    const rs = [...this.stats.values()];
    if (!rs.length) return null;
    const sum = rs.reduce((a, s) => a + (s.frames ? s.hit / s.frames : 0), 0);
    return Math.round((sum / rs.length) * 100);
  }

  phrases(): PhraseScore[] {
    return [...this.stats.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([i, s]) => ({
        note: this.notes[i],
        voiced: s.frames ? s.voiced / s.frames : 0,
        hit: s.frames ? s.hit / s.frames : 0,
        meanCents: s.voiced ? s.cents / s.voiced : 0,
      }));
  }
}

/** Groups notes into singable phrases, splitting where the melody rests. */
export function phraseBounds(notes: Note[], restGap = 0.7): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const n of notes) {
    const last = out[out.length - 1];
    if (last && n.t - last.end < restGap) last.end = n.t + n.d;
    else out.push({ start: n.t, end: n.t + n.d });
  }
  return out;
}
