import { PitchDetector } from "pitchy";
import { freqToMidi } from "./notes";

export type PitchFrame = { t: number; midi: number | null; clarity: number; db: number };

const WINDOW = 2048;

export class PitchTracker {
  minClarity = 0.9;
  minDb = -50;

  private buf = new Float32Array(WINDOW);
  private detector = PitchDetector.forFloat32Array(WINDOW);

  private constructor(readonly ctx: AudioContext, private analyser: AnalyserNode, readonly stream?: MediaStream) {}

  private static analyserFor(ctx: AudioContext, src: AudioNode): AnalyserNode {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = WINDOW;
    src.connect(analyser);
    return analyser;
  }

  static async open(ctx: AudioContext): Promise<PitchTracker> {
    // Voice processing bends pitch and ducks sustained notes, so turn all of it off.
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    return new PitchTracker(ctx, PitchTracker.analyserFor(ctx, ctx.createMediaStreamSource(stream)), stream);
  }

  /** Analyse an audio node instead of the microphone, to check the app against itself. */
  static fromNode(ctx: AudioContext, node: AudioNode): PitchTracker {
    return new PitchTracker(ctx, PitchTracker.analyserFor(ctx, node));
  }

  read(): PitchFrame {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) sum += v * v;
    const db = 10 * Math.log10(sum / WINDOW + 1e-12);
    const [freq, clarity] = this.detector.findPitch(this.buf, this.ctx.sampleRate);
    const voiced = db > this.minDb && clarity >= this.minClarity && freq > 60 && freq < 1400;
    return { t: this.ctx.currentTime, midi: voiced ? freqToMidi(freq) : null, clarity, db };
  }
}
