import { describe, it, expect } from 'vitest';
import { snapBeat } from '../quantize';

describe('snapBeat', () => {
  it('returns target unchanged when quantize is disabled', () => {
    expect(snapBeat(1.234, 0)).toBe(1.234);
    expect(snapBeat(1.234, -1)).toBe(1.234);
  });

  it('snaps forward to the next 16th-note grid point', () => {
    // q = 16 -> step = 4/16 = 0.25 beats
    expect(snapBeat(0.0,  16)).toBe(0.0);
    expect(snapBeat(0.1,  16)).toBe(0.25);
    expect(snapBeat(0.25, 16)).toBe(0.25);   // exactly on grid: stays
    expect(snapBeat(0.26, 16)).toBe(0.5);
  });

  it('snaps to a quarter-note grid', () => {
    // q = 4 -> step = 1.0 beat
    expect(snapBeat(0.5, 4)).toBe(1.0);
    expect(snapBeat(1.0, 4)).toBe(1.0);
    expect(snapBeat(1.5, 4)).toBe(2.0);
  });

  it('does not push exactly-on-grid points forward (epsilon guard)', () => {
    expect(snapBeat(2.0, 16)).toBe(2.0);
    expect(snapBeat(4.0, 4)).toBe(4.0);
  });
});
