import { centsOff, foldToward } from "./notes";
import type { PitchFrame } from "./pitch";
import { playNote } from "./tone";

export type Target = { midi: number; start: number; end: number; kind: "listen" | "sing" };
export type NoteResult = { midi: number; voiced: number; hit: number; meanCents: number };

/** Time after each sung note starts that is not judged, to allow for reaction and sliding in. */
const GRACE = 0.2;

export class Lesson {
  readonly targets: Target[] = [];
  readonly singEnd: number;
  private stats: { frames: number; voiced: number; hit: number; centsSum: number }[];

  constructor(
    ctx: AudioContext,
    readonly midis: number[],
    readonly toleranceCents: number,
    readonly octaveFree: boolean,
    noteDur = 0.9,
  ) {
    const t0 = ctx.currentTime + 0.3;
    midis.forEach((m, i) => {
      const s = t0 + i * noteDur;
      this.targets.push({ midi: m, start: s, end: s + noteDur, kind: "listen" });
      playNote(ctx, m, s, noteDur - 0.05);
    });
    const singStart = t0 + midis.length * noteDur + 0.8;
    midis.forEach((m, i) => {
      const s = singStart + i * noteDur;
      this.targets.push({ midi: m, start: s, end: s + noteDur, kind: "sing" });
    });
    this.singEnd = singStart + midis.length * noteDur;
    this.stats = midis.map(() => ({ frames: 0, voiced: 0, hit: 0, centsSum: 0 }));
  }

  /** The sing target active at time t, if any. */
  activeSing(t: number): { target: Target; index: number } | undefined {
    const sing = this.targets.filter((x) => x.kind === "sing");
    const index = sing.findIndex((x) => t >= x.start && t < x.end);
    return index < 0 ? undefined : { target: sing[index], index };
  }

  /** Judge one frame. Returns the pitch to display and whether it was on target. */
  feed(f: PitchFrame): { display: number | null; judge?: boolean; cents?: number } {
    const a = this.activeSing(f.t);
    if (!a) return { display: f.midi };
    const { target, index } = a;
    if (f.midi === null) {
      if (f.t >= target.start + GRACE) this.stats[index].frames++;
      return { display: null };
    }
    const cents = centsOff(f.midi, target.midi, this.octaveFree);
    const display = this.octaveFree ? foldToward(f.midi, target.midi) : f.midi;
    const judge = Math.abs(cents) <= this.toleranceCents;
    if (f.t >= target.start + GRACE) {
      const s = this.stats[index];
      s.frames++;
      s.voiced++;
      s.centsSum += cents;
      if (judge) s.hit++;
    }
    return { display, judge, cents };
  }

  results(): NoteResult[] {
    return this.stats.map((s, i) => ({
      midi: this.midis[i],
      voiced: s.frames ? s.voiced / s.frames : 0,
      hit: s.voiced ? s.hit / s.voiced : 0,
      meanCents: s.voiced ? s.centsSum / s.voiced : 0,
    }));
  }
}

/** Random question inside [lo, hi]; consecutive notes differ by 1 to 7 semitones. */
export function makeQuestion(count: number, lo: number, hi: number): number[] {
  const out = [lo + Math.floor(Math.random() * (hi - lo + 1))];
  while (out.length < count) {
    const prev = out[out.length - 1];
    const options: number[] = [];
    for (let d = -7; d <= 7; d++) {
      if (d !== 0 && prev + d >= lo && prev + d <= hi) options.push(prev + d);
    }
    out.push(options[Math.floor(Math.random() * options.length)]);
  }
  return out;
}
