// Forward-only port of the Norns/Crow `sequins` library.
// Each call to next() yields the current value and advances the cursor,
// wrapping at length. Wrapping a scalar gives a length-1 sequins so the
// burst engine can treat scalars and patterns uniformly (mirrors `as_seq`).

export interface Sequins<T> {
  next(): T;
  reset(): void;
  readonly length: number;
  // Position the NEXT call to next() will return. Useful for UI playheads:
  // the just-fired step is `(index - 1 + length) % length`.
  readonly index: number;
  // Read-only view of the underlying values, so UIs can render the pattern
  // without having to consume the iterator.
  readonly values: readonly T[];
}

export function sequins<T>(values: readonly T[]): Sequins<T> {
  if (values.length === 0) {
    throw new Error('sequins() requires a non-empty array');
  }
  const buf = values.slice();
  let i = 0;
  return {
    next() {
      const v = buf[i];
      i = (i + 1) % buf.length;
      return v;
    },
    reset() { i = 0; },
    get length() { return buf.length; },
    get index() { return i; },
    get values() { return buf as readonly T[]; },
  };
}

export function isSequins<T>(v: unknown): v is Sequins<T> {
  return typeof v === 'object' && v !== null
    && typeof (v as Sequins<T>).next === 'function'
    && typeof (v as Sequins<T>).length === 'number';
}

export function asSeq<T>(v: T | Sequins<T>): Sequins<T> {
  return isSequins<T>(v) ? v : sequins([v]);
}

// Two sequins to be added at fire time. The engine stores `a` and `b`
// separately on `ChannelState` so the grid can view/edit each layer
// independently; `sum()` is just the REPL-side packaging that `launch()`
// recognizes and unpacks.
export interface SumLayers<T> {
  readonly __sum: true;
  readonly a: Sequins<T>;
  readonly b: Sequins<T>;
}

export function sum<T>(a: T | Sequins<T>, b: T | Sequins<T>): SumLayers<T> {
  return { __sum: true, a: asSeq(a), b: asSeq(b) };
}

export function isSumLayers<T>(v: unknown): v is SumLayers<T> {
  return typeof v === 'object' && v !== null && (v as SumLayers<T>).__sum === true;
}
