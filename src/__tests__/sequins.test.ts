import { describe, it, expect } from 'vitest';
import { sequins, asSeq, isSequins } from '../sequins';

describe('sequins', () => {
  it('yields values in order and wraps', () => {
    const s = sequins([10, 20, 30]);
    expect(s.next()).toBe(10);
    expect(s.next()).toBe(20);
    expect(s.next()).toBe(30);
    expect(s.next()).toBe(10);
  });

  it('exposes length', () => {
    expect(sequins([1, 2, 3]).length).toBe(3);
    expect(sequins([42]).length).toBe(1);
  });

  it('index points at the next-to-yield slot, advancing on next()', () => {
    const s = sequins([1, 2, 3]);
    expect(s.index).toBe(0);
    s.next();
    expect(s.index).toBe(1);
    s.next();
    s.next();
    expect(s.index).toBe(0);
  });

  it('reset() returns the cursor to 0', () => {
    const s = sequins([1, 2, 3]);
    s.next(); s.next();
    expect(s.index).toBe(2);
    s.reset();
    expect(s.index).toBe(0);
    expect(s.next()).toBe(1);
  });

  it('values is a read-only snapshot of the underlying array', () => {
    const s = sequins([5, 6, 7]);
    expect(s.values).toEqual([5, 6, 7]);
  });

  it('throws when constructed with an empty array', () => {
    expect(() => sequins([])).toThrow();
  });

  it('asSeq wraps scalars into a length-1 sequins', () => {
    const s = asSeq(7);
    expect(s.length).toBe(1);
    expect(s.next()).toBe(7);
    expect(s.next()).toBe(7);
  });

  it('asSeq passes existing sequins through unchanged', () => {
    const original = sequins([1, 2]);
    expect(asSeq(original)).toBe(original);
  });

  it('isSequins discriminates correctly', () => {
    expect(isSequins(sequins([1]))).toBe(true);
    expect(isSequins(7)).toBe(false);
    expect(isSequins([1, 2, 3])).toBe(false);
    expect(isSequins(null)).toBe(false);
  });
});
