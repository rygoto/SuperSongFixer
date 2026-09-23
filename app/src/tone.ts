import { midiToFreq } from "./notes";

let wave: PeriodicWave | undefined;

/** A soft organ-like tone: clear fundamental so it is easy to match by ear. */
export function playNote(ctx: AudioContext, midi: number, start: number, dur: number, volume = 0.3) {
  wave ??= ctx.createPeriodicWave(
    new Float32Array([0, 1, 0.45, 0.25, 0.12, 0.06]),
    new Float32Array(6),
  );
  const osc = ctx.createOscillator();
  osc.setPeriodicWave(wave);
  osc.frequency.value = midiToFreq(midi);

  const g = ctx.createGain();
  g.gain.setValueAtTime(0, start);
  g.gain.linearRampToValueAtTime(volume, start + 0.02);
  g.gain.setValueAtTime(volume * 0.8, start + dur - 0.08);
  g.gain.linearRampToValueAtTime(0, start + dur);

  osc.connect(g).connect(ctx.destination);
  osc.start(start);
  osc.stop(start + dur + 0.05);
}
