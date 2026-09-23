import { noteName } from "./notes";
import type { Target } from "./lesson";

export type Point = { t: number; midi: number | null; judge?: boolean };

const PAST = 4.5;
const FUTURE = 1.5;
const SPAN = 16; // semitones visible

export class PitchGraph {
  private center = 60;
  private ctx: CanvasRenderingContext2D;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }

  draw(now: number, points: Point[], targets: Target[]) {
    const { canvas, ctx } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const css = getComputedStyle(canvas);
    const col = (n: string) => css.getPropertyValue(n).trim();

    // Follow the visible targets, else the recent voice, easing so the view does not jump.
    const visible = targets.filter((x) => x.end > now - PAST && x.start < now + FUTURE);
    const recent = points.filter((p) => p.midi !== null && p.t > now - 1).map((p) => p.midi!);
    const pool = visible.length ? visible.map((x) => x.midi) : recent;
    if (pool.length) {
      const want = (Math.min(...pool) + Math.max(...pool)) / 2;
      this.center += (want - this.center) * 0.08;
    }
    const lo = this.center - SPAN / 2;
    const x = (t: number) => ((t - (now - PAST)) / (PAST + FUTURE)) * w;
    const y = (m: number) => h - ((m - lo) / SPAN) * h;

    ctx.fillStyle = col("--graph-bg");
    ctx.fillRect(0, 0, w, h);

    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    for (let m = Math.ceil(lo); m <= lo + SPAN; m++) {
      const isC = ((m % 12) + 12) % 12 === 0;
      ctx.strokeStyle = col(isC ? "--grid-strong" : "--grid");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y(m) + 0.5);
      ctx.lineTo(w, y(m) + 0.5);
      ctx.stroke();
      if (isC) {
        ctx.fillStyle = col("--muted");
        ctx.fillText(noteName(m), 4, y(m) - 7);
      }
    }

    for (const tg of visible) {
      const sing = tg.kind === "sing";
      ctx.fillStyle = col(sing ? "--target" : "--target-listen");
      const x0 = x(tg.start), x1 = x(tg.end);
      ctx.beginPath();
      ctx.roundRect(x0, y(tg.midi + 0.5), x1 - x0 - 2, y(tg.midi - 0.5) - y(tg.midi + 0.5), 4);
      ctx.fill();
      ctx.fillStyle = col("--text");
      ctx.fillText(noteName(tg.midi), x0 + 4, y(tg.midi));
    }

    // Now line
    ctx.strokeStyle = col("--now");
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x(now), 0);
    ctx.lineTo(x(now), h);
    ctx.stroke();

    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (a.midi === null || b.midi === null || b.t - a.t > 0.1) continue;
      // An octave fold between frames would draw a vertical spike, so skip it.
      if (Math.abs(b.midi - a.midi) > 6) continue;
      ctx.strokeStyle = col(b.judge === undefined ? "--voice" : b.judge ? "--hit" : "--miss");
      ctx.beginPath();
      ctx.moveTo(x(a.t), y(a.midi));
      ctx.lineTo(x(b.t), y(b.midi));
      ctx.stroke();
    }
  }
}
