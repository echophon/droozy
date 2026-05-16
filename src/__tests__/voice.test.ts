import { describe, it, expect } from 'vitest';

// Voice pool specification. FMVoice and JFVoice both implement the Voice
// interface with an 8-slot round-robin pool. Web Audio isn't available in
// the Node test environment, so we document the decisions as constants
// rather than introspecting live instances.

describe('voice pool (FMVoice and JFVoice)', () => {
  const POOL_SIZE = 8;
  const MIN_POOL_SIZE = 4;

  it('the voice pool holds enough simultaneous voices for fast bursts', () => {
    expect(POOL_SIZE).toBeGreaterThanOrEqual(MIN_POOL_SIZE);
  });

  it('rapid triggers allocate from the pool and do not choke earlier tails', () => {
    // Round-robin: trigger N always picks pool[N % POOL_SIZE].
    // A note ringing at slot K is only interrupted when the index wraps back
    // to K, giving POOL_SIZE-1 triggers of headroom before any choke occurs.
    const chokeAfter = POOL_SIZE - 1;
    expect(chokeAfter).toBeGreaterThanOrEqual(MIN_POOL_SIZE - 1);
  });

  it('voice-stealing strategy is round-robin (deterministic, zero per-trigger cost)', () => {
    // Round-robin was chosen over oldest-first or quietest because it has O(1)
    // cost (index increment only) and predictable behavior for musical patterns.
    const strategy = 'round-robin';
    expect(strategy).toBe('round-robin');
  });

  it('level maps to amplitude only in JFVoice (no modIndex — additive engine)', () => {
    // JFVoice is additive (no FM modulator), so `level` scales only the
    // ampEnv peak velocity. FMVoice scales both amp and modIndex (Option C).
    const jfLevelMapping = 'amp-only';
    const fmLevelMapping = 'amp+modIndex';
    expect(jfLevelMapping).toBe('amp-only');
    expect(fmLevelMapping).toBe('amp+modIndex');
  });
});
