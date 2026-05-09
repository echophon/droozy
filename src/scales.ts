// Scale degree → frequency. The Lua original returns volts (1V/oct);
// we return Hz directly since Tone.js synths take frequency in Hz.

export const scales = {
  chromatic:  [0,1,2,3,4,5,6,7,8,9,10,11],
  major:      [0,2,4,5,7,9,11],
  minor:      [0,2,3,5,7,8,10],
  pentatonic: [0,2,4,7,9],
  dorian:     [0,2,3,5,7,9,10],

  // Eastern + percussion-flavoured scales. Bayati and rast traditionally use
  // quarter-tone intervals (E half-flat, B half-flat); approximated here to
  // the nearest semitone so the integer-degree model still works. If you
  // ever want microtonal accuracy, switch to a cents-based model.
  akebono:    [0,2,3,7,8],          // Japanese pentatonic
  hijaz:      [0,1,4,5,7,8,10],     // Arabic maqam Hijaz (b2, M3)
  kurd:       [0,1,3,5,7,8,10],     // Maqam Kurd (Phrygian-like)
  bayati:     [0,1,3,5,7,8,10],     // Maqam Bayati (semitone approximation)
  rast:       [0,2,4,5,7,9,10],     // Maqam Rast (semitone approximation)
  zen:        [0,1,5,6,10],         // Iwato — Japanese, sometimes labelled "Zen"
  wuSheng:    [0,2,4,7,9],          // 五声 — Chinese pentatonic (same intervals as major-pentatonic)
} as const;

export type ScaleName = keyof typeof scales;

// Octave-aware degree lookup, matches Lua note_to_volts: degree 7 in major
// wraps to the next octave's degree 0 (root + 12 semitones).
export function degreeToSemitones(degree: number, scale: readonly number[]): number {
  const len = scale.length;
  // floor-mod handles negative degrees correctly (-1 in major = previous B)
  const oct = Math.floor(degree / len);
  const idx = ((degree % len) + len) % len;
  return oct * 12 + scale[idx];
}

// Default root C1 (32.70 Hz) — sub-bass register so the picker's full degree
// range (0..31) stays in usable percussive territory rather than climbing
// into piercing highs. The fundamental is on the edge of speaker reproduction
// at the bottom, but FM modulation creates harmonics that carry the perceived
// pitch — exactly the regime where percussive FM lives (kick drums, toms).
export function degreeToFreq(
  degree: number,
  scale: readonly number[],
  rootHz = 32.7032,
): number {
  return rootHz * Math.pow(2, degreeToSemitones(degree, scale) / 12);
}
