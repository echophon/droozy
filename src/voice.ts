import * as Tone from 'tone';

// Percussive FM voice. The burst engine will call triggerAt(when, freq, level)
// once per event; voices need to be polyphonic (overlap allowed) so that fast
// bursts ring out naturally rather than choking each other.
//
// The current implementation is a deliberately minimal stub: ONE oscillator,
// ONE modulator, ONE active voice per channel. It will play, but new triggers
// hard-cut whatever is ringing. THIS IS WHERE YOU TAKE OVER — see the
// learning-mode contribution section in the plan, and the TODOs below.

export interface VoiceParams {
  /** carrier:modulator frequency ratio. 1 = same pitch, 2 = octave up, etc. */
  harmonicity: number;
  /** peak FM modulation depth (in modulator amplitude units) */
  modIndex: number;
  /** modulator envelope decay in seconds (controls timbral evolution) */
  modDecay: number;
  /** amp envelope decay in seconds (controls perceived note length) */
  ampDecay: number;
  /** envelope curve: 'exponential' = snappier, 'linear' = softer */
  curve: 'exponential' | 'linear';
}

export const defaultVoiceParams: VoiceParams = {
  harmonicity: 2,
  modIndex: 8,
  modDecay: 0.05,
  ampDecay: 0.4,
  curve: 'exponential',
};

export class FMVoice {
  private params: VoiceParams;
  private out: Tone.Gain;

  // === Stub voice: single carrier + modulator, monophonic ======================
  // TODO (learning): replace with a voice POOL. Decisions to make:
  //   - pool size (4? 8? 16?)
  //   - voice-stealing strategy (oldest? quietest? round-robin?)
  //   - one Tone.Gain per voice for independent amp envelopes
  //   - one Tone.Oscillator for the modulator per voice (so two simultaneous
  //     notes don't share the same FM modulator and beat against each other)
  private carrier: Tone.Oscillator;
  private modulator: Tone.Oscillator;
  private modGain: Tone.Gain;     // scales modulator output (Hz units) into carrier.frequency
  private ampEnv: Tone.AmplitudeEnvelope;

  constructor(destination: Tone.InputNode, params: VoiceParams = defaultVoiceParams) {
    this.params = { ...params };
    this.out = new Tone.Gain(1).connect(destination);

    this.ampEnv = new Tone.AmplitudeEnvelope({
      attack: 0.001,
      decay: this.params.ampDecay,
      sustain: 0,
      release: 0.01,
      attackCurve: this.params.curve,
      decayCurve: this.params.curve,
    }).connect(this.out);

    this.carrier = new Tone.Oscillator({ type: 'sine', frequency: 220 }).start();
    this.carrier.connect(this.ampEnv);

    this.modulator = new Tone.Oscillator({ type: 'sine', frequency: 440 }).start();
    this.modGain = new Tone.Gain(0);
    this.modulator.connect(this.modGain);
    this.modGain.connect(this.carrier.frequency);
  }

  /**
   * Trigger one percussive FM hit. `when` is an absolute audio time from
   * Tone.now(). `freq` is the carrier in Hz. `level` is 0..1.
   *
   * TODO (learning): how should `level` shape the timbre?
   *   Option A: amp only        — louder hits, same brightness
   *   Option B: mod-index only  — same loudness, brighter on accents
   *   Option C: both            — accents are louder AND brighter (current)
   *   Option D: + pitch sweep   — high level → short downward pitch glide on
   *                                the carrier (drum-like "thump")
   *
   * Also TODO: pick a voice from the pool here, instead of retriggering the
   * single shared carrier/modulator. As written, fast bursts will choke.
   */
  // Carrier start-frequency multipliers and sweep durations for each pitchEnv value.
  // Index 0 = off (unused). Higher index = slower, wider sweep.
  private static readonly PITCH_SWEEP_START = [1, 4, 2, 1.5] as const;
  private static readonly PITCH_SWEEP_TIME  = [0, 0.03, 0.12, 0.35] as const;

  triggerAt(when: number, freq: number, level: number, harmonicity?: number, env?: number, decaySec?: number, pitchEnv?: number): void {
    const lv = Math.max(0, Math.min(1, level));
    // Per-trigger harmonicity overrides the voice default; the burst engine
    // sequences this per-step so each note can have its own timbral character.
    const harm = harmonicity ?? this.params.harmonicity;

    // env (0..1) shapes the envelope from snappy → longer-but-still-percussive.
    // 0 reproduces the voice's static defaults exactly (matching legacy calls
    // that pass no env). 1 caps at "long perc" — never a sustained pad.
    // decaySec bypasses the 0..1 range entirely and sets ampDec directly in
    // wall-clock seconds (burst-timed and hit-timed env modes).
    let attackTime: number;
    let ampDec: number;
    let modDec: number;
    if (decaySec !== undefined) {
      attackTime = 0.001;
      ampDec = Math.max(0.01, decaySec);
      modDec = ampDec * 0.4;
    } else if (env !== undefined) {
      const e = Math.max(0, Math.min(1, env));
      attackTime = 0.001 + e * 0.024;     // 1ms → 25ms
      ampDec = 0.4 + e * 0.8;              // 0.4s → 1.2s
      modDec = 0.05 + e * 0.25;            // 0.05s → 0.3s
    } else {
      attackTime = 0.001;
      ampDec = this.params.ampDecay;
      modDec = this.params.modDecay;
    }
    this.ampEnv.attack = attackTime;
    this.ampEnv.decay = ampDec;

    const pEnv = pitchEnv ?? 0;
    if (pEnv > 0) {
      const startMult = FMVoice.PITCH_SWEEP_START[pEnv];
      const sweepTime = FMVoice.PITCH_SWEEP_TIME[pEnv];
      this.carrier.frequency.cancelScheduledValues(when);
      this.carrier.frequency.setValueAtTime(freq * startMult, when);
      this.carrier.frequency.exponentialRampToValueAtTime(freq, when + sweepTime);
      this.modulator.frequency.cancelScheduledValues(when);
      this.modulator.frequency.setValueAtTime(freq * startMult * harm, when);
      this.modulator.frequency.exponentialRampToValueAtTime(freq * harm, when + sweepTime);
    } else {
      this.carrier.frequency.setValueAtTime(freq, when);
      this.modulator.frequency.setValueAtTime(freq * harm, when);
    }

    // Schedule mod-depth envelope directly in Hz (envelope nodes are 0..1; we
    // need real Hz here). Snappy attack, then exponential decay to near-zero.
    const peakMod = freq * this.params.modIndex * lv;
    const floor = Math.max(peakMod * 0.001, 0.0001);
    this.modGain.gain.cancelScheduledValues(when);
    this.modGain.gain.setValueAtTime(floor, when);
    this.modGain.gain.linearRampToValueAtTime(peakMod, when + 0.001);
    this.modGain.gain.exponentialRampToValueAtTime(floor, when + modDec);

    // Total duration = attack + decay so the release phase doesn't truncate
    // the natural decay tail.
    this.ampEnv.triggerAttackRelease(ampDec + attackTime, when, lv);
  }

  setParams(p: Partial<VoiceParams>): void {
    Object.assign(this.params, p);
    this.ampEnv.decay = this.params.ampDecay;
    this.ampEnv.attackCurve = this.params.curve;
    this.ampEnv.decayCurve = this.params.curve;
  }
}
