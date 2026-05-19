import * as Tone from 'tone';

export interface Voice {
  triggerAt(when: number, freq: number, level: number,
    harmonicity?: number, env?: number, decaySec?: number): void;
}

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

interface PoolVoice {
  carrier: Tone.Oscillator;
  modulator: Tone.Oscillator;
  modGain: Tone.Gain;
  ampEnv: Tone.AmplitudeEnvelope;
}

export class FMVoice implements Voice {
  private params: VoiceParams;
  private out: Tone.Gain;

  private static readonly POOL_SIZE = 8;
  private pool: PoolVoice[];
  private poolIndex = 0;

  constructor(destination: Tone.InputNode, params: VoiceParams = defaultVoiceParams) {
    this.params = { ...params };
    this.out = new Tone.Gain(1).connect(destination);

    this.pool = Array.from({ length: FMVoice.POOL_SIZE }, () => {
      const ampEnv = new Tone.AmplitudeEnvelope({
        attack: 0.001,
        decay: this.params.ampDecay,
        sustain: 0,
        release: 0.01,
        attackCurve: this.params.curve,
        decayCurve: this.params.curve,
      }).connect(this.out);

      const carrier = new Tone.Oscillator({ type: 'sine', frequency: 220 }).start();
      carrier.connect(ampEnv);

      const modulator = new Tone.Oscillator({ type: 'sine', frequency: 440 }).start();
      const modGain = new Tone.Gain(0);
      modulator.connect(modGain);
      modGain.connect(carrier.frequency);

      return { carrier, modulator, modGain, ampEnv };
    });
  }

  triggerAt(when: number, freq: number, level: number, harmonicity?: number, env?: number, decaySec?: number): void {
    const lv = Math.max(0, Math.min(1, level));
    const harm = harmonicity ?? this.params.harmonicity;

    let attackTime: number;
    let ampDec: number;
    let modDec: number;
    if (decaySec !== undefined) {
      attackTime = 0.001;
      ampDec = Math.max(0.01, decaySec);
      modDec = ampDec * 0.4;
    } else if (env !== undefined) {
      const e = Math.max(0, Math.min(1, env));
      attackTime = 0.001 + e * 0.024;
      ampDec = 0.4 + e * 0.8;
      modDec = 0.05 + e * 0.25;
    } else {
      attackTime = 0.001;
      ampDec = this.params.ampDecay;
      modDec = this.params.modDecay;
    }

    const voice = this.pool[this.poolIndex];
    this.poolIndex = (this.poolIndex + 1) % FMVoice.POOL_SIZE;

    voice.ampEnv.attack = attackTime;
    voice.ampEnv.decay = ampDec;

    voice.carrier.frequency.setValueAtTime(freq, when);
    voice.modulator.frequency.setValueAtTime(freq * harm, when);

    const peakMod = freq * this.params.modIndex * lv;
    const floor = Math.max(peakMod * 0.001, 0.0001);
    voice.modGain.gain.cancelScheduledValues(when);
    voice.modGain.gain.setValueAtTime(floor, when);
    voice.modGain.gain.linearRampToValueAtTime(peakMod, when + 0.001);
    voice.modGain.gain.exponentialRampToValueAtTime(floor, when + modDec);

    voice.ampEnv.triggerAttackRelease(ampDec + attackTime, when, lv);
  }

  setParams(p: Partial<VoiceParams>): void {
    Object.assign(this.params, p);
    for (const voice of this.pool) {
      voice.ampEnv.decay = this.params.ampDecay;
      voice.ampEnv.attackCurve = this.params.curve;
      voice.ampEnv.decayCurve = this.params.curve;
    }
  }
}
