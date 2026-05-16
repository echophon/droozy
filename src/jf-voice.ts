import * as Tone from 'tone';

// Additive harmonic-stack voice inspired by Mannequins Just Friends (sound range).
// Each pool slot runs `slopes` oscillators at proportionally related frequencies
// (INTONE), summed through a shared amplitude envelope with adjustable attack/decay
// balance (RAMP). Waveform type (CURVE) is the primary spectral control — sawtooth
// is the most JF-authentic since JF's slope generators are literal ramp waveforms.

export interface JFVoiceParams {
  /** number of harmonic partials per voice (1..6; JF has 6 slopes) */
  slopes: number;
  /** amplitude envelope decay in seconds */
  ampDecay: number;
  /** waveform shape — controls spectral brightness */
  curve: 'sine' | 'triangle' | 'sawtooth' | 'square';
}

export const defaultJFVoiceParams: JFVoiceParams = {
  slopes: 4,
  ampDecay: 0.4,
  curve: 'sawtooth',
};

interface JFPoolVoice {
  oscillators: Tone.Oscillator[];
  oscGains: Tone.Gain[];
  ampEnv: Tone.AmplitudeEnvelope;
  voiceOut: Tone.Gain;
}

export class JFVoice {
  private params: JFVoiceParams;
  private out: Tone.Gain;

  private static readonly POOL_SIZE = 8;
  // RAMP table: attack fraction of total envelope duration.
  // 0 = fully percussive; 0.5 = symmetric swell (bell-like).
  private static readonly RAMP_TABLE = [0, 0.15, 0.35, 0.5] as const;
  // Pitch sweep — same tables as FMVoice so pitchEnv behaves identically.
  private static readonly PITCH_SWEEP_START = [1, 4, 2, 1.5] as const;
  private static readonly PITCH_SWEEP_TIME  = [0, 0.03, 0.12, 0.35] as const;

  private pool: JFPoolVoice[];
  private poolIndex = 0;

  constructor(destination: Tone.InputNode, params: JFVoiceParams = defaultJFVoiceParams) {
    this.params = { ...params };
    this.out = new Tone.Gain(1).connect(destination);

    this.pool = Array.from({ length: JFVoice.POOL_SIZE }, () =>
      this.buildPoolVoice(),
    );
  }

  private buildPoolVoice(): JFPoolVoice {
    // Harmonic rolloff: partial i has weight 1/(i+1). Normalize by their sum
    // so total output level is consistent regardless of slopes count.
    const weights = Array.from({ length: this.params.slopes }, (_, i) => 1 / (i + 1));
    const weightSum = weights.reduce((a, b) => a + b, 0);

    const voiceOut = new Tone.Gain(1 / weightSum).connect(this.out);
    const ampEnv = new Tone.AmplitudeEnvelope({
      attack: 0.001,
      decay: this.params.ampDecay,
      sustain: 0,
      release: 0.01,
    }).connect(voiceOut);

    const oscillators: Tone.Oscillator[] = [];
    const oscGains: Tone.Gain[] = [];

    for (let i = 0; i < this.params.slopes; i++) {
      const oscGain = new Tone.Gain(weights[i]).connect(ampEnv);
      const osc = new Tone.Oscillator({
        type: this.params.curve,
        frequency: 220 * (i + 1),
      }).start();
      osc.connect(oscGain);
      oscillators.push(osc);
      oscGains.push(oscGain);
    }

    return { oscillators, oscGains, ampEnv, voiceOut };
  }

  /**
   * Trigger one percussive hit.
   *
   * harmonicity → INTONE: harmonic spread. Normalized as `harm / 24` (0..1).
   *   At 0: all slopes unison. At 1: slopes at freq * [1, 2, 3, ... slopes].
   *
   * harmEnv → RAMP: attack/decay balance preset (0–3).
   *   0 = fully percussive (matches FMVoice default).
   *   3 = half attack / half decay (bell/swell shape).
   *
   * env, decaySec → envelope duration, same semantics as FMVoice.
   * pitchEnv → pitch sweep on all slopes (maintains harmonic ratios during sweep).
   */
  triggerAt(when: number, freq: number, level: number, harmonicity?: number, env?: number, decaySec?: number, pitchEnv?: number, harmEnv?: number): void {
    const lv = Math.max(0, Math.min(1, level));
    const intone = harmonicity !== undefined ? Math.max(0, Math.min(1, harmonicity / 24)) : 0;

    // Envelope base duration (same three-mode logic as FMVoice)
    let baseAttack: number;
    let baseDec: number;
    if (decaySec !== undefined) {
      baseAttack = 0.001;
      baseDec = Math.max(0.01, decaySec);
    } else if (env !== undefined) {
      const e = Math.max(0, Math.min(1, env));
      baseAttack = 0.001 + e * 0.024;
      baseDec = 0.4 + e * 0.8;
    } else {
      baseAttack = 0.001;
      baseDec = this.params.ampDecay;
    }

    // RAMP splits total duration into attack and decay portions
    const rampIdx = Math.max(0, Math.min(3, Math.round(harmEnv ?? 0))) as 0 | 1 | 2 | 3;
    const rampFrac = JFVoice.RAMP_TABLE[rampIdx];
    const totalDur = baseAttack + baseDec;
    const attackDur = Math.max(0.001, rampFrac * totalDur);
    const decayDur  = Math.max(0.01,  totalDur - attackDur);

    const voice = this.pool[this.poolIndex];
    this.poolIndex = (this.poolIndex + 1) % JFVoice.POOL_SIZE;

    voice.ampEnv.attack = attackDur;
    voice.ampEnv.decay  = decayDur;

    const pEnv = pitchEnv ?? 0;
    const pitchMult = pEnv > 0 ? JFVoice.PITCH_SWEEP_START[pEnv] : 1;
    const pitchTime = pEnv > 0 ? JFVoice.PITCH_SWEEP_TIME[pEnv] : 0;

    // Schedule all slopes. The pitch sweep scales all slopes by pitchMult so
    // harmonic relationships are preserved throughout the sweep — all slopes
    // glide together, as JF's shared RAMP/CURVE applies across all slopes.
    for (let i = 0; i < voice.oscillators.length; i++) {
      const targetFreq = freq * (1 + i * intone);
      const osc = voice.oscillators[i];
      osc.frequency.cancelScheduledValues(when);
      if (pEnv > 0) {
        osc.frequency.setValueAtTime(targetFreq * pitchMult, when);
        osc.frequency.exponentialRampToValueAtTime(targetFreq, when + pitchTime);
      } else {
        osc.frequency.setValueAtTime(targetFreq, when);
      }
    }

    voice.ampEnv.triggerAttackRelease(totalDur, when, lv);
  }

  setParams(p: Partial<JFVoiceParams>): void {
    Object.assign(this.params, p);
    if (p.curve !== undefined) {
      for (const voice of this.pool) {
        for (const osc of voice.oscillators) {
          osc.type = this.params.curve;
        }
      }
    }
    if (p.ampDecay !== undefined) {
      for (const voice of this.pool) {
        voice.ampEnv.decay = this.params.ampDecay;
      }
    }
  }
}
