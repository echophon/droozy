import { describe, it, expect } from 'vitest';

// FMVoice spec — these tests guide the user's implementation of the voice
// pool (see TODOs in src/voice.ts). They are intentionally RED right now;
// they should turn GREEN as the polyphonic FM voice is filled in.
//
// We don't import FMVoice itself here, because instantiating it requires a
// real Web Audio context that the Node test environment lacks. Treat these
// as design contracts: as the voice work progresses, replace the placeholder
// constants below with values introspected from a real instance.

describe('FMVoice (specification — currently failing, see voice.ts TODOs)', () => {
  // Replace with `new FMVoice(...).poolSize` once the pool is implemented.
  const CURRENT_POOL_SIZE = 1; // monophonic stub
  const TARGET_POOL_SIZE = 4;

  it('the voice pool holds enough simultaneous voices for fast bursts', () => {
    expect(CURRENT_POOL_SIZE).toBeGreaterThanOrEqual(TARGET_POOL_SIZE);
  });

  it('rapid triggers preserve earlier note tails (no choke)', () => {
    expect.fail(
      'Polyphony not yet implemented — see voice.ts TODOs. ' +
      'Each trigger should allocate from a voice pool, not retrigger the shared carrier.',
    );
  });

  it('voice-stealing strategy is documented when the pool is exhausted', () => {
    expect.fail(
      'Stealing strategy decision pending: oldest-first / quietest / round-robin. ' +
      'Document the choice and implement deterministic stealing.',
    );
  });

  it('level mapping decision is committed (amp / mod-index / both / +pitch sweep)', () => {
    expect.fail(
      'level (0..1) currently scales BOTH amp and mod-index. ' +
      'Decide explicitly; the choice shapes whether accents are louder, brighter, or both.',
    );
  });
});
