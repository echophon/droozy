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
  slopes: 1,
  ampDecay: 0.2,
  curve: 'sawtooth',
};

interface JFPoolVoice {
  oscillators: Tone.Oscillator[];
  oscGains: Tone.Gain[];
  filter: Tone.Filter;
  ampEnv: Tone.AmplitudeEnvelope;
  voiceOut: Tone.Gain;
}

export class JFVoice {
  private params: JFVoiceParams;
  private out: Tone.Gain;

  private static readonly POOL_SIZE = 8;

  private pool: JFPoolVoice[];
  private poolIndex = 0;

  constructor(destination: Tone.InputNode, params: JFVoiceParams = defaultJFVoiceParams) {
    this.params = { ...params };
    // Normalize to match FM/MG energy: single-slope sawtooth is louder than
    // FM's sine carrier + the old 4-slope voiceOut factor was ~0.48.
    this.out = new Tone.Gain(0.5).connect(destination);

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

    // LPG: 2-pole lowpass decays in tandem with the amplitude envelope,
    // closing from a bright harmonic opening toward the fundamental.
    const filter = new Tone.Filter({
      type: 'lowpass',
      frequency: 20000,
      rolloff: -12,
      Q: 0.5,
    }).connect(ampEnv);

    const oscillators: Tone.Oscillator[] = [];
    const oscGains: Tone.Gain[] = [];

    for (let i = 0; i < this.params.slopes; i++) {
      const oscGain = new Tone.Gain(weights[i]).connect(filter);
      const osc = new Tone.Oscillator({
        type: this.params.curve,
        frequency: 220 * (i + 1),
      }).start();
      osc.connect(oscGain);
      oscillators.push(osc);
      oscGains.push(oscGain);
    }

    return { oscillators, oscGains, filter, ampEnv, voiceOut };
  }

  /**
   * Trigger one percussive hit.
   *
   * harmonicity → INTONE: harmonic spread across slopes.
   *   harm=2 → all slopes in unison; harm=24 → 1:2:3:4:5:6 harmonic series.
   *
   * env → envelope duration AND RAMP (attack/decay balance).
   *   env=0 → fully percussive; env=1 → 50% attack / 50% decay (bell/swell).
   *
   * decaySec → override envelope duration (from envMode in burst engine).
   * slopeIndex → channel's JF slope identity (0=IDENTITY, 1=2N, …, 5=6N).
   */
  triggerAt(when: number, freq: number, level: number, harmonicity?: number, env?: number, decaySec?: number, slopeIndex?: number): void {
    const lv = Math.max(0, Math.min(1, level));
    // harm=2 → intone=0 (all slopes in unison); harm=24 → intone=1 (1:2:3:4:5:6 harmonic series)
    const intone = Math.max(0, Math.min(1, ((harmonicity ?? 2) - 2) / 22));

    // Envelope base duration
    let baseAttack: number;
    let baseDec: number;
    if (decaySec !== undefined) {
      baseAttack = 0.001;
      baseDec = Math.max(0.01, decaySec);
    } else if (env !== undefined) {
      const e = Math.max(0, Math.min(1, env));
      baseAttack = 0.001 + e * 0.024;
      baseDec = 0.2 + e * 0.4;
    } else {
      baseAttack = 0.001;
      baseDec = this.params.ampDecay;
    }

    // Use the same attack/decay split as FM so envelope length feels identical.
    const attackDur = baseAttack;
    const decayDur  = baseDec;
    const totalDur  = attackDur + decayDur;

    const voice = this.pool[this.poolIndex];
    this.poolIndex = (this.poolIndex + 1) % JFVoice.POOL_SIZE;

    voice.ampEnv.attack = attackDur;
    voice.ampEnv.decay  = decayDur;

    // LPG filter: opens to a bright harmonic cutoff on attack, decays to the
    // fundamental over the same duration as the amplitude envelope.
    const cutoffHigh = Math.min(18000, freq * 20);
    const cutoffLow  = Math.max(freq, 40);
    voice.filter.frequency.cancelScheduledValues(when);
    voice.filter.frequency.setValueAtTime(cutoffHigh, when);
    voice.filter.frequency.exponentialRampToValueAtTime(cutoffLow, when + decayDur);

    // slopeIndex is the channel's JF slope identity (0=IDENTITY, 1=2N, ..., 5=6N).
    // Each slope plays at freq × (1 + slopeIndex × intone); additional internal
    // oscillators (slopes > 1) stack upward from there.
    const idx = slopeIndex ?? 0;
    for (let i = 0; i < voice.oscillators.length; i++) {
      const targetFreq = freq * (1 + (idx + i) * intone);
      voice.oscillators[i].frequency.setValueAtTime(targetFreq, when);
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
