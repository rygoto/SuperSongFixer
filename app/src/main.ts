import { PitchGraph, type Point } from "./graph";
import { Lesson, makeQuestion, type Target } from "./lesson";
import { centsOff, noteName, solfege } from "./notes";
import { PitchTracker } from "./pitch";
import { loadIndex, loadSong, phraseBounds, SongPlayer, SongScorer, type SongEntry } from "./song";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const ui = {
  status: $("status"), note: $("note"), solfege: $("solfege"), needle: $("needle"), cents: $("cents"),
  phase: $("phase"), mic: $<HTMLButtonElement>("mic"), newQ: $<HTMLButtonElement>("new"),
  again: $<HTMLButtonElement>("again"), result: $("result"),
  count: $<HTMLSelectElement>("count"), lo: $<HTMLSelectElement>("lo"), hi: $<HTMLSelectElement>("hi"),
  tol: $<HTMLSelectElement>("tol"), octave: $<HTMLInputElement>("octave"),
  tabLesson: $<HTMLButtonElement>("tab-lesson"), tabSong: $<HTMLButtonElement>("tab-song"),
  viewLesson: $("view-lesson"), viewSong: $("view-song"),
  songsel: $<HTMLSelectElement>("songsel"), songload: $<HTMLButtonElement>("songload"), songmsg: $("songmsg"),
  transport: $("transport"), seek: $<HTMLInputElement>("seek"), loopbar: $("loopbar"),
  tnow: $("tnow"), tend: $("tend"), play: $<HTMLButtonElement>("play"),
  prevPhrase: $<HTMLButtonElement>("prevPhrase"), nextPhrase: $<HTMLButtonElement>("nextPhrase"),
  loopPhrase: $<HTMLButtonElement>("loopPhrase"), markA: $<HTMLButtonElement>("markA"),
  markB: $<HTMLButtonElement>("markB"), loopClear: $<HTMLButtonElement>("loopClear"),
  live: $("live"), songResult: $("song-result"), selftest: $<HTMLInputElement>("selftest"),
  key: $<HTMLInputElement>("key"), keyval: $("keyval"), guide: $<HTMLInputElement>("guide"), guideval: $("guideval"),
  vol: $<HTMLInputElement>("vol"), volval: $("volval"), latency: $<HTMLInputElement>("latency"), latval: $("latval"),
};

// Range selects: C2 to C6
for (const sel of [ui.lo, ui.hi]) {
  for (let m = 36; m <= 84; m++) sel.add(new Option(`${noteName(m)}（${solfege(m)}）`, String(m)));
}

const SETTINGS_KEY = "songfixer.settings";
const fields = { count: ui.count, lo: ui.lo, hi: ui.hi, tol: ui.tol, key: ui.key, guide: ui.guide, vol: ui.vol, latency: ui.latency };
function loadSettings() {
  let s: Record<string, string | boolean> = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}"); } catch { /* storage unavailable */ }
  ui.count.value = String(s.count ?? "1");
  ui.lo.value = String(s.lo ?? "48");
  ui.hi.value = String(s.hi ?? "67");
  ui.tol.value = String(s.tol ?? "50");
  ui.octave.checked = s.octave !== false;
  ui.key.value = String(s.key ?? "0");
  ui.guide.value = String(s.guide ?? "0");
  ui.vol.value = String(s.vol ?? "80");
  ui.latency.value = String(s.latency ?? "120");
}
function saveSettings() {
  const s: Record<string, string | boolean> = { octave: ui.octave.checked };
  for (const [k, el] of Object.entries(fields)) s[k] = el.value;
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* storage unavailable */ }
}
loadSettings();
for (const el of [...Object.values(fields), ui.octave]) el.addEventListener("change", saveSettings);

const graph = new PitchGraph($<HTMLCanvasElement>("graph"));
let ctx: AudioContext | undefined;
let tracker: PitchTracker | undefined;
let mode: "lesson" | "song" = "lesson";

/** The shared clock for playback and scoring. Created on the first user gesture. */
function audio(): AudioContext {
  ctx ??= new AudioContext({ latencyHint: "interactive" });
  void ctx.resume();
  return ctx;
}

ui.mic.onclick = async () => {
  try {
    tracker = await PitchTracker.open(audio());
  } catch (e) {
    ui.status.textContent = "マイクを使えませんでした";
    console.error(e);
    return;
  }
  try { await navigator.wakeLock?.request("screen"); } catch { /* optional */ }
  ui.status.textContent = "マイクオン";
  ui.mic.hidden = true;
  ui.newQ.hidden = mode === "song";
};

function setMode(m: "lesson" | "song") {
  mode = m;
  ui.tabLesson.classList.toggle("on", m === "lesson");
  ui.tabSong.classList.toggle("on", m === "song");
  ui.viewLesson.hidden = m === "song";
  ui.viewSong.hidden = m === "lesson";
  ui.newQ.hidden = m === "song" || !ctx;
  ui.again.hidden = m === "song" || !lastQuestion.length;
  ui.phase.textContent = "";
  points = [];
  if (m === "lesson") player?.stop();
  else lesson = undefined;
  syncPlayButton();
}
ui.tabLesson.onclick = () => setMode("lesson");
ui.tabSong.onclick = () => setMode("song");

// ---- 音程練習 ----

let lesson: Lesson | undefined;
let lastQuestion: number[] = [];
let points: Point[] = [];
const recentVoice: number[] = [];

function start(midis: number[]) {
  if (!ctx) return;
  let lo = Number(ui.lo.value), hi = Number(ui.hi.value);
  if (lo > hi) [lo, hi] = [hi, lo];
  lastQuestion = midis.length ? midis : makeQuestion(Number(ui.count.value), lo, hi);
  lesson = new Lesson(ctx, lastQuestion, Number(ui.tol.value), ui.octave.checked);
  ui.result.hidden = true;
  ui.newQ.disabled = ui.again.disabled = true;
}
ui.newQ.onclick = () => start([]);
ui.again.onclick = () => start(lastQuestion);

function lessonFrame(now: number, midi: number | null) {
  let display = midi;
  let judge: boolean | undefined;
  let cents: number | undefined;
  if (lesson) {
    ({ display, judge, cents } = lesson.feed({ t: now, midi, clarity: 0, db: 0 }));
    const listenEnd = Math.max(...lesson.targets.filter((x) => x.kind === "listen").map((x) => x.end));
    ui.phase.textContent = now < listenEnd ? "お手本を聴いて…" : now < lesson.singEnd ? "歌って！" : "";
    if (now > lesson.singEnd + 0.2) finish(lesson);
  }
  points.push({ t: now, midi: display, judge });
  points = points.filter((p) => p.t > now - 5);
  updateReadout(midi, cents);
  graph.draw(now, points, lesson?.targets ?? []);
}

function finish(l: Lesson) {
  lesson = undefined;
  ui.phase.textContent = "";
  ui.newQ.disabled = ui.again.disabled = false;
  ui.again.hidden = false;

  const rs = l.results();
  const score = Math.round((rs.reduce((a, r) => a + r.hit * r.voiced, 0) / rs.length) * 100);
  const rows = rs.map((r) => {
    let tend = "";
    if (r.voiced < 0.3) tend = "声が拾えませんでした";
    else if (r.meanCents > 20) tend = `平均 +${Math.round(r.meanCents)} セント（高め）`;
    else if (r.meanCents < -20) tend = `平均 ${Math.round(r.meanCents)} セント（低め）`;
    else tend = `平均 ${r.meanCents >= 0 ? "+" : ""}${Math.round(r.meanCents)} セント`;
    return `<li><b>${noteName(r.midi)}（${solfege(r.midi)}）</b><span>${Math.round(r.hit * 100)}%</span><small>${tend}</small></li>`;
  });
  ui.result.innerHTML = `<div class="score">${score}<small>点</small></div><ul>${rows.join("")}</ul>`;
  ui.result.hidden = false;
}

// ---- 曲で練習 ----

let player: SongPlayer | undefined;
let scorer: SongScorer | undefined;
let targets: Target[] = [];
let phrases: { start: number; end: number }[] = [];
let lastSongTime = 0;
let lastLapScore: number | null = null;
let seeking = false;

let selfTracker: PitchTracker | undefined;
let selfTrackerFor: SongPlayer | undefined;

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const keyShift = () => Number(ui.key.value);
/** No acoustic path when the reference is fed back in, so no latency to correct. */
const latency = () => (ui.selftest.checked ? 0 : Number(ui.latency.value) / 1000);

/** Analyses the guide vocal in place of the microphone, so the app can check itself. */
function selfTest(): PitchTracker | undefined {
  if (!ui.selftest.checked || !player || !ctx) return undefined;
  if (selfTrackerFor !== player) {
    selfTracker = PitchTracker.fromNode(ctx, player.tap);
    selfTrackerFor = player;
  }
  return selfTracker;
}
ui.selftest.addEventListener("change", () => { resetScorer(); });

loadIndex().then((list: SongEntry[]) => {
  ui.songsel.replaceChildren();
  for (const s of list) ui.songsel.add(new Option(`${s.title}${s.artist ? ` / ${s.artist}` : ""}`, s.id));
  ui.songmsg.textContent = list.length ? "" : "曲がありません。tools/prepare_song.py で作ってください。";
  ui.songload.disabled = !list.length;
}).catch(() => { ui.songmsg.textContent = "曲一覧を読めませんでした"; });

ui.songload.onclick = async () => {
  const id = ui.songsel.value;
  ui.songload.disabled = true;
  ui.songmsg.textContent = "読み込み中…";
  try {
    player?.stop();
    const ac = audio();
    const song = await loadSong(ac, id);
    player = new SongPlayer(ac, song);
    phrases = phraseBounds(song.notes);
    ui.tend.textContent = mmss(song.duration);
    ui.transport.hidden = false;
    ui.songmsg.textContent = `${song.notes.length} ノート / ${phrases.length} フレーズ${song.vocals ? "" : "（お手本ボーカルなし）"}`;
    applySongSettings();
    resetScorer();
    player.seek(song.notes[0] ? Math.max(0, song.notes[0].t - 2) : 0);
    drawSeek();
  } catch (e) {
    ui.songmsg.textContent = "読み込みに失敗しました";
    console.error(e);
  }
  ui.songload.disabled = false;
};

function resetScorer() {
  if (!player) return;
  scorer = new SongScorer(player.song.notes, Number(ui.tol.value), ui.octave.checked, keyShift());
  targets = scorer.targets();
  points = [];
}

function applySongSettings() {
  if (!player) return;
  player.rate = 2 ** (keyShift() / 12);
  player.guide = Number(ui.guide.value) / 100;
  player.volume = Number(ui.vol.value) / 100;
  if (scorer) { scorer.keyShift = keyShift(); targets = scorer.targets(); }
  const k = keyShift();
  ui.keyval.textContent = k === 0 ? "±0" : `${k > 0 ? "+" : ""}${k}`;
  ui.guideval.textContent = `${ui.guide.value}%`;
  ui.volval.textContent = `${ui.vol.value}%`;
  ui.latval.textContent = `${ui.latency.value}ms`;
}
for (const el of [ui.key, ui.guide, ui.vol, ui.latency]) {
  el.addEventListener("input", () => {
    const wasKey = el === ui.key;
    applySongSettings();
    if (wasKey) player?.refresh();
  });
}
ui.tol.addEventListener("change", () => { if (scorer) scorer.toleranceCents = Number(ui.tol.value); });
ui.octave.addEventListener("change", () => { if (scorer) scorer.octaveFree = ui.octave.checked; });

function syncPlayButton() {
  ui.play.textContent = player?.playing ? "停止" : "再生";
}
ui.play.onclick = () => {
  if (!player) return;
  if (player.playing) { player.stop(); showSongResult(); }
  else { audio(); resetScorer(); ui.songResult.hidden = true; player.start(); }
  syncPlayButton();
};

ui.seek.addEventListener("pointerdown", () => { seeking = true; });
ui.seek.addEventListener("pointerup", () => { seeking = false; });
ui.seek.addEventListener("input", () => {
  if (!player) return;
  const t = (Number(ui.seek.value) / 1000) * player.song.duration;
  ui.tnow.textContent = mmss(t);
  player.seek(t);
  points = [];
});

/** The phrase containing (or next after) the playhead. */
function phraseAt(t: number): number {
  const i = phrases.findIndex((p) => t < p.end);
  return i < 0 ? phrases.length - 1 : i;
}
function gotoPhrase(i: number) {
  if (!player || !phrases.length) return;
  const p = phrases[Math.max(0, Math.min(phrases.length - 1, i))];
  if (player.loop) setLoop(Math.max(0, p.start - 0.5), p.end + 0.3);
  else { player.seek(Math.max(0, p.start - 1)); points = []; }
  drawSeek();
}
ui.prevPhrase.onclick = () => gotoPhrase(phraseAt(player?.time() ?? 0) - 1);
ui.nextPhrase.onclick = () => gotoPhrase(phraseAt(player?.time() ?? 0) + 1);
ui.loopPhrase.onclick = () => {
  if (!player || !phrases.length) return;
  const p = phrases[phraseAt(player.time())];
  setLoop(Math.max(0, p.start - 0.5), p.end + 0.3);
};

function setLoop(a: number, b: number) {
  if (!player || b - a < 0.5) return;
  player.loop = { a, b };
  player.refresh();
  if (!player.playing) player.seek(a);
  resetScorer();
  drawSeek();
}
ui.markA.onclick = () => {
  if (!player) return;
  const a = player.time();
  setLoop(a, player.loop && player.loop.b > a + 0.5 ? player.loop.b : Math.min(player.song.duration, a + 8));
};
ui.markB.onclick = () => {
  if (!player) return;
  const b = player.time();
  setLoop(player.loop && player.loop.a < b - 0.5 ? player.loop.a : Math.max(0, b - 8), b);
};
ui.loopClear.onclick = () => {
  if (!player) return;
  player.loop = null;
  player.refresh();
  drawSeek();
};

function drawSeek() {
  if (!player) return;
  const d = player.song.duration;
  if (player.loop) {
    ui.loopbar.hidden = false;
    ui.loopbar.style.left = `${(player.loop.a / d) * 100}%`;
    ui.loopbar.style.width = `${((player.loop.b - player.loop.a) / d) * 100}%`;
  } else {
    ui.loopbar.hidden = true;
  }
}

function songFrame(midi: number | null) {
  if (!player || !scorer) { graph.draw(0, [], []); return; }
  const now = player.time();
  // The frame we just read is about `latency` seconds behind what the ear heard.
  const vt = now - latency();

  if (now < lastSongTime - 0.5) {
    // Looped around: the previous pass is a finished attempt.
    lastLapScore = scorer.score();
    scorer.reset();
    points = [];
  }
  lastSongTime = now;

  const { display, judge, cents } = scorer.feed(vt, midi);
  points.push({ t: vt, midi: display, judge });
  points = points.filter((p) => p.t > vt - 5 && p.t < vt + 0.5);

  updateReadout(midi, cents);
  graph.draw(now, points, targets);

  if (!seeking) {
    ui.seek.value = String(Math.round((now / player.song.duration) * 1000));
    ui.tnow.textContent = mmss(now);
  }
  const live = scorer.score();
  ui.live.textContent = [
    live === null ? "" : `いま ${live} 点`,
    lastLapScore === null ? "" : `前回 ${lastLapScore} 点`,
    player.loop ? `ループ ${mmss(player.loop.a)}〜${mmss(player.loop.b)}` : "",
  ].filter(Boolean).join("　/　");

  if (player.ended) { player.stop(); showSongResult(); syncPlayButton(); }
}

function showSongResult() {
  if (!scorer) return;
  const total = scorer.score();
  if (total === null) { ui.songResult.hidden = true; return; }
  const worst = scorer.phrases()
    .filter((p) => p.note.d >= 0.15)
    .sort((a, b) => a.hit - b.hit)
    .slice(0, 8)
    .map((p) => {
      const tend = p.voiced < 0.3 ? "声なし" : `${p.meanCents >= 0 ? "+" : ""}${Math.round(p.meanCents)} セント`;
      return `<li><b>${mmss(p.note.t)} ${noteName(p.note.m + scorer!.keyShift)}</b><span>${Math.round(p.hit * 100)}%</span><small>${tend}</small></li>`;
    });
  ui.songResult.innerHTML = `<div class="score">${total}<small>点</small></div><p class="muted small">苦手だった音</p><ul>${worst.join("")}</ul>`;
  ui.songResult.hidden = false;
}

// ---- 共通 ----

function loop() {
  requestAnimationFrame(loop);
  if (mode === "song") {
    // Song mode still runs without a microphone, so you can play the melody back.
    const src = selfTest() ?? tracker;
    songFrame(src?.read().midi ?? null);
    return;
  }
  const f = tracker?.read();
  if (f) lessonFrame(f.t, f.midi);
}
requestAnimationFrame(loop);

function updateReadout(midi: number | null, cents: number | undefined) {
  if (midi === null) return;
  // Median of recent frames keeps the big note label from flickering.
  recentVoice.push(midi);
  if (recentVoice.length > 7) recentVoice.shift();
  const m = [...recentVoice].sort((a, b) => a - b)[recentVoice.length >> 1];
  ui.note.textContent = noteName(m);
  ui.solfege.textContent = solfege(m);
  // Without a target, show deviation from the nearest semitone.
  const c = cents ?? centsOff(m, Math.round(m), false);
  const clamped = Math.max(-100, Math.min(100, c));
  ui.needle.style.left = `${50 + clamped / 2}%`;
  ui.needle.dataset.state = Math.abs(c) <= Number(ui.tol.value) ? "hit" : "miss";
  ui.cents.textContent = `${c >= 0 ? "+" : ""}${Math.round(c)} セント${cents === undefined ? "" : "（目標比）"}`;
}
