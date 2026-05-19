import * as Tone from 'tone';

// Formant oscillator voice inspired by Mannequins Mangrove.
//
// Three primary controls map to the triggerAt signature:
//   BARREL  (harmonicity) — impulse rise/fall ratio → oscillator waveform type AND formant index
//   AIR     (level)       — VCA amplitude AND saturation drive into a tanh waveshaper
//
// Barrel drives both waveform (sawtooth→triangle→square) and bandpass filter cutoff+Q
// on the same axis: low harm = sawtooth/dark, high harm = square/bright. When harm
// geode is active in the burst engine, both waveform and formant evolve together across hits.

export interface MangroveVoiceParams {
  /** amplitude envelope decay in seconds */
  ampDecay: number;
}

export const defaultMangroveVoiceParams: MangroveVoiceParams = {
  ampDecay: 0.35,
};

interface MGPoolVoice {
  oscillator: Tone.Oscillator;
  filter: Tone.Filter;
  ampEnv: Tone.AmplitudeEnvelope;
  waveshaper: Tone.WaveShaper;
  voiceOut: Tone.Gain;
}

export class MangroveVoice {
  private params: MangroveVoiceParams;
  private out: Tone.Gain;

  private static readonly POOL_SIZE = 8;

  // FORMANT presets: bandpass cutoff multiplier and Q indexed by barrel (0–3).
  // 0 = dark/wide (1× carrier), 3 = bright/narrow (12× carrier, Q=8).
  private static readonly FORMANT_RATIO = [1, 3, 6, 12] as const;
  private static readonly FORMANT_Q     = [1, 2, 4, 8]  as const;

  private pool: MGPoolVoice[];
  private poolIndex = 0;

  constructor(destination: Tone.InputNode, params: MangroveVoiceParams = defaultMangroveVoiceParams) {
    this.params = { ...params };
    this.out = new Tone.Gain(1).connect(destination);
    this.pool = Array.from({ length: MangroveVoice.POOL_SIZE }, () => this.buildPoolVoice());
  }

  private buildPoolVoice(): MGPoolVoice {
    // tanh soft-clip curve with drive=2, normalized to ±1 output.
    // Low signal → linear (clean); high signal → shoulder → saturation.
    const curveLen = 2048;
    const curve = new Float32Array(curveLen);
    const norm = Math.tanh(2);
    for (let i = 0; i < curveLen; i++) {
      const x = (i * 2 / (curveLen - 1)) - 1;
      curve[i] = Math.tanh(x * 2) / norm;
    }

    const voiceOut = new Tone.Gain(1).connect(this.out);
    const waveshaper = new Tone.WaveShaper(curve).connect(voiceOut);
    const ampEnv = new Tone.AmplitudeEnvelope({
      attack: 0.001,
      decay: this.params.ampDecay,
      sustain: 0,
      release: 0.01,
    }).connect(waveshaper);

    // Bandpass filter: cutoff and Q track barrel (derived from harmonicity).
    const filter = new Tone.Filter({
      type: 'bandpass',
      frequency: 440,
      Q: 1,
    }).connect(ampEnv);

    const oscillator = new Tone.Oscillator({ type: 'sawtooth', frequency: 220 }).start();
    oscillator.connect(filter);

    return { oscillator, filter, ampEnv, waveshaper, voiceOut };
  }

  /**
   * Trigger one percussive Mangrove hit.
   *
   * harmonicity → BARREL: waveform shape AND formant position.
   *   `barrel = clamp((harm-2)/23, 0..1)` → sawtooth/dark … square/bright.
   *   Both waveform and bandpass filter track barrel, so harm geode evolves
   *   timbre and filter together across burst hits.
   *
   * level → AIR: amplitude AND saturation drive.
   *   Low level stays in tanh linear region (clean).
   *   High level clips into tanh shoulder (harmonic edge).
   */
  triggerAt(when: number, freq: number, level: number, harmonicity?: number, env?: number, decaySec?: number): void {
    const lv = Math.max(0, Math.min(1, level));

    // BARREL → waveform type and formant index (shared axis)
    const harm = harmonicity ?? 2;
    const barrel = Math.max(0, Math.min(1, (harm - 2) / 23));
    const oscType: Tone.ToneOscillatorType =
      barrel < 0.33 ? 'sawtooth' :
      barrel < 0.67 ? 'triangle' :
                      'square';
    const formantIdx = Math.min(3, Math.floor(barrel * 4)) as 0 | 1 | 2 | 3;
    const filterCutoff = freq * MangroveVoice.FORMANT_RATIO[formantIdx];
    const filterQ      = MangroveVoice.FORMANT_Q[formantIdx];

    // Envelope duration (same logic as FMVoice)
    let attackTime: number;
    let ampDec: number;
    if (decaySec !== undefined) {
      attackTime = 0.001;
      ampDec = Math.max(0.01, decaySec);
    } else if (env !== undefined) {
      const e = Math.max(0, Math.min(1, env));
      attackTime = 0.001 + e * 0.024;
      ampDec = 0.4 + e * 0.8;
    } else {
      attackTime = 0.001;
      ampDec = this.params.ampDecay;
    }

    const voice = this.pool[this.poolIndex];
    this.poolIndex = (this.poolIndex + 1) % MangroveVoice.POOL_SIZE;

    voice.oscillator.type = oscType;
    voice.filter.frequency.cancelScheduledValues(when);
    voice.filter.frequency.setValueAtTime(filterCutoff, when);
    voice.filter.Q.setValueAtTime(filterQ, when);
    voice.ampEnv.attack = attackTime;
    voice.ampEnv.decay  = ampDec;
    voice.oscillator.frequency.setValueAtTime(freq, when);

    voice.ampEnv.triggerAttackRelease(attackTime + ampDec, when, lv);
  }

  setParams(p: Partial<MangroveVoiceParams>): void {
    Object.assign(this.params, p);
    if (p.ampDecay !== undefined) {
      for (const voice of this.pool) {
        voice.ampEnv.decay = this.params.ampDecay;
      }
    }
  }
}
