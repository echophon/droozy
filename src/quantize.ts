// Pure beat-snapping math, extracted from clock.ts so it can be unit-tested
// without pulling in Tone.js (which needs an AudioContext that test
// environments don't have).
//
// `quantize` follows the Norns convention: a value of N means "N events per
// whole note" (so 4 = quarter notes, 16 = sixteenths). Step size in beats
// is therefore 4/N. quantize <= 0 disables snapping.

export function snapBeat(target: number, quantize: number): number {
  if (quantize <= 0) return target;
  const step = 4 / quantize;
  // Epsilon nudge: when target is *exactly* on a grid point, naive ceiling
  // would push it forward one step. The 1e-9 guard prevents that without
  // affecting any other case.
  // The `+ 0` at the end normalises -0 to +0 (target=0 + epsilon nudge can
  // produce -0 from Math.ceil; functionally identical, but trips Object.is).
  return Math.ceil(target / step - 1e-9) * step + 0;
}
