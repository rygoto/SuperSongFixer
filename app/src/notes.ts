const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SOLFEGE = ["ド", "ド#", "レ", "レ#", "ミ", "ファ", "ファ#", "ソ", "ソ#", "ラ", "ラ#", "シ"];

export const freqToMidi = (f: number) => 69 + 12 * Math.log2(f / 440);
export const midiToFreq = (m: number) => 440 * 2 ** ((m - 69) / 12);

const pc = (m: number) => ((Math.round(m) % 12) + 12) % 12;
export const noteName = (m: number) => NAMES[pc(m)] + (Math.floor(Math.round(m) / 12) - 1);
export const solfege = (m: number) => SOLFEGE[pc(m)];

/** Signed deviation in cents. With octaveFree, singing an octave away counts as on pitch. */
export function centsOff(sung: number, target: number, octaveFree: boolean): number {
  const c = (sung - target) * 100;
  return octaveFree ? (((c % 1200) + 1800) % 1200) - 600 : c;
}

/** Shift a sung pitch by whole octaves so it sits nearest the target, for display. */
export function foldToward(sung: number, target: number): number {
  return sung + Math.round((target - sung) / 12) * 12;
}
