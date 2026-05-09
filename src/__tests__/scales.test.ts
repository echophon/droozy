import { describe, it, expect } from 'vitest';
import { scales, degreeToSemitones, degreeToFreq } from '../scales';

describe('degreeToSemitones', () => {
  it('returns root semitone for degree 0', () => {
    expect(degreeToSemitones(0, scales.major)).toBe(0);
    expect(degreeToSemitones(0, scales.chromatic)).toBe(0);
  });

  it('walks up the major scale', () => {
    // major: [0, 2, 4, 5, 7, 9, 11]
    expect(degreeToSemitones(1, scales.major)).toBe(2);
    expect(degreeToSemitones(2, scales.major)).toBe(4);
    expect(degreeToSemitones(4, scales.major)).toBe(7);
    expect(degreeToSemitones(6, scales.major)).toBe(11);
  });

  it('wraps to next octave at degree == scale length', () => {
    // major has 7 notes, so degree 7 = root + 12 semitones
    expect(degreeToSemitones(7, scales.major)).toBe(12);
    expect(degreeToSemitones(14, scales.major)).toBe(24);
  });

  it('handles negative degrees by wrapping into the previous octave', () => {
    // degree -1 in major = previous B (-1 semitone from root)
    expect(degreeToSemitones(-1, scales.major)).toBe(-1);
    // degree -7 = full octave below root
    expect(degreeToSemitones(-7, scales.major)).toBe(-12);
  });

  it('respects pentatonic scale', () => {
    // pentatonic: [0, 2, 4, 7, 9]  (5 notes)
    expect(degreeToSemitones(0, scales.pentatonic)).toBe(0);
    expect(degreeToSemitones(3, scales.pentatonic)).toBe(7);
    expect(degreeToSemitones(5, scales.pentatonic)).toBe(12);  // octave at degree 5
  });

  it('walks the eastern scales correctly', () => {
    // akebono: [0, 2, 3, 7, 8] — Japanese pentatonic
    expect(degreeToSemitones(2, scales.akebono)).toBe(3);
    expect(degreeToSemitones(5, scales.akebono)).toBe(12);
    // hijaz: [0, 1, 4, 5, 7, 8, 10] — Arabic, b2 + M3 gives the exotic flavour
    expect(degreeToSemitones(1, scales.hijaz)).toBe(1);
    expect(degreeToSemitones(2, scales.hijaz)).toBe(4);
    expect(degreeToSemitones(7, scales.hijaz)).toBe(12);
    // wuSheng: [0, 2, 4, 7, 9] — Chinese pentatonic, same intervals as major pent
    expect(degreeToSemitones(3, scales.wuSheng)).toBe(7);
  });
});

describe('degreeToFreq', () => {
  it('uses the supplied root and ascends by semitones', () => {
    // 12 semitones up = double frequency
    expect(degreeToFreq(0, scales.chromatic, 440)).toBeCloseTo(440, 5);
    expect(degreeToFreq(12, scales.chromatic, 440)).toBeCloseTo(880, 5);
  });

  it('descends an octave for negative full-scale degrees', () => {
    expect(degreeToFreq(-12, scales.chromatic, 440)).toBeCloseTo(220, 5);
  });

  it('default root is C1 (~32.70 Hz) — sub-bass kick/tom range', () => {
    expect(degreeToFreq(0, scales.chromatic)).toBeCloseTo(32.7032, 3);
  });
});
