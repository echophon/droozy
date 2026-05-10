import * as Tone from 'tone';
import { Sequins, SumLayers, asSeq, isSumLayers, sequins } from './sequins';
import { scales, degreeToFreq } from './scales';
import { getBeats, waitUntilBeat } from './clock';
import { snapBeat } from './quantize';
import type { FMVoice } from './voice';

export const NUM_CHANNELS = 6;

export interface ChannelState {
  div: Sequins<number>;
  reps: Sequins<number>;
  note: Sequins<number>;
  level: Sequins<number>;
  // FM modulator-to-carrier frequency ratio, advanced once per burst (like
  // note and level). Integer ratios produce harmonic spectra; non-integer
  // ratios produce inharmonic / metallic timbres.
  harm: Sequins<number>;
  // Envelope shape, 0..1. 0 = snappy default (current behaviour). 1 = longer
  // attack and decay while still in percussive territory.
  env: Sequins<number>;
  // B layers — each defaults to sequins([0]) (additive identity). At fire
  // time the engine sums `xB.next()` into `x.next()` for every param. Stored
  // as parallel sequins (rather than a fused "sum sequins") so the grid can
  // view and edit each layer independently — they advance their own .index.
  divB: Sequins<number>;
  repsB: Sequins<number>;
  noteB: Sequins<number>;
  levelB: Sequins<number>;
  harmB: Sequins<number>;
  envB: Sequins<number>;
  // Per-note-position mute mask. true = silent (skip voice trigger but keep
  // the playhead and timing advancing). Parallel to `note.values`; missing
  // entries are treated as unmuted. Mute is keyed off A's note positions
  // only — B has no parallel mute mask.
  noteMute: boolean[];
}

type LaunchVal = number | Sequins<number> | SumLayers<number>;

export interface LaunchOpts {
  div?:   LaunchVal;
  reps?:  LaunchVal;
  note?:  LaunchVal;
  level?: LaunchVal;
  harm?:  LaunchVal;
  env?:   LaunchVal;
}

export type BurstEvent =
  | { type: 'fire'; ch: number; beat: number; freq: number; level: number }
  | { type: 'launch'; ch: number }
  | { type: 'stop'; ch: number };

type Listener = (ev: BurstEvent) => void;

function defaultChannel(): ChannelState {
  return {
    div:   sequins([4,8]),
    reps:  sequins([2,2]),
    note:  sequins([0]),
    level: sequins([0.6]),
    harm:  sequins([2]),
    env:   sequins([0]),
    divB:   sequins([0]),
    repsB:  sequins([0]),
    noteB:  sequins([0]),
    levelB: sequins([0]),
    harmB:  sequins([0]),
    envB:   sequins([0]),
    noteMute: [],
  };
}

// Geode-style per-hit amplitude. `run` is the level param interpreted as a
// bipolar RUN CV: 0.5 = neutral (0V), 0 = full negative, 1 = full positive.
function geodeAmplitude(mode: 1 | 2 | 3, run: number, i: number, total: number): number {
  const r = (run - 0.5) * 2;  // -1..+1

  if (mode === 1) {  // Transient: sawtooth accent cycle
    if (Math.abs(r) < 0.01) return 1.0;
    const cycleLen = Math.max(1, Math.round(1 + Math.abs(r) * 9));
    const pos = i % cycleLen;
    return r > 0
      ? 1.0 - pos / cycleLen    // sawtooth down from accent
      : (pos + 1) / cycleLen;   // reversed: rises to accent
  }

  if (mode === 2) {  // Sustain: decay with triangle fold/reflect
    const period = total === Infinity ? 8 : Math.max(2, total);
    const idx = total === Infinity ? i % period : i;
    const t = idx / (period - 1);
    const rate = r >= 0 ? 1 + r * 4 : Math.max(0.05, 1 + r);  // 0.05..5
    const raw = t * rate;
    return Math.abs(((raw % 2) + 2) % 2 - 1);  // triangle: 1→0→1→0...
  }

  // mode === 3: Cycle — sinusoidal, continuous period
  if (Math.abs(r) < 0.01) return 1.0;
  const freq = r > 0
    ? 1 / (2 + r * 8)       // period 2..10 hits as r → 0..1
    : 1 + Math.abs(r) * 9;  // 1..10 cycles/hit (sub-beat, quasi-random)
  return 0.5 + 0.5 * Math.cos(2 * Math.PI * i * freq);
}

export class BurstEngine {
  readonly channels: ChannelState[];
  // Per-fire snap grid (events per whole note). Each event's target time is
  // snapped to this grid before firing. 0 disables per-fire snapping (events
  // happen at their ideal 4/div positions; useful for free-running rhythms).
  // Default 16 = 16th-note correction.
  quantize = 16;
  // Envelope timing mode:
  //   0 = shape  — env 0..1 maps to fixed time ranges (existing behaviour)
  //   1 = burst  — amp decay = total burst duration (reps × hit interval)
  //   2 = hit    — amp decay = interval between hits (4/div beats)
  // Modes 1 and 2 make the envelope musically in-sync with the pattern.
  // In mode 1 with infinite reps, falls back to hit-interval (same as mode 2).
  envMode: 0 | 1 | 2 = 0;
  // Geode amplitude mode (from Just-Friends Geode spec). Controls how per-hit
  // amplitude varies within a burst, using `level` as the "RUN voltage" input
  // (0.5 = neutral/0V, 0 = full negative, 1 = full positive):
  //   0 = off       — level is direct amplitude (unchanged)
  //   1 = transient — sawtooth accent cycle; n-hit period set by level
  //   2 = sustain   — amplitude decays (and folds) across the burst
  //   3 = cycle     — sinusoidal cycling with continuous period
  geodeMode: 0 | 1 | 2 | 3 = 0;
  // Launch alignment grid. The global-clock equivalent of "wait for the next
  // pulse." A user click is unreliable as a clock source, so launches snap
  // forward to the next launchGrid beat boundary. This makes simultaneous
  // launches across channels lock onto a shared phase regardless of the
  // exact moment the user pressed the buttons. 0 disables launch alignment
  // entirely. Default 4 = next quarter note.
  launchGrid = 4;
  // Global scale shared across all channels. Direct mutation is fine; call
  // controller.refresh() (or the REPL's `refresh()`) to update the grid.
  scale: readonly number[] = scales.major;

  private voices: FMVoice[];
  private tokens: number[] = new Array(NUM_CHANNELS).fill(0);
  private running: boolean[] = new Array(NUM_CHANNELS).fill(false);
  private listeners = new Set<Listener>();

  constructor(voices: FMVoice[]) {
    if (voices.length !== NUM_CHANNELS) {
      throw new Error(`expected ${NUM_CHANNELS} voices, got ${voices.length}`);
    }
    this.voices = voices;
    this.channels = Array.from({ length: NUM_CHANNELS }, defaultChannel);
  }

  on(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  isRunning(ch: number): boolean {
    return this.running[ch] ?? false;
  }

  // Lua launch(): patch the channel state, cancel any in-flight coroutine
  // by bumping the cancellation token, then start a fresh async loop.
  launch(ch1: number, opts: LaunchOpts = {}): void {
    const ch = ch1 - 1;  // public API is 1-indexed like the Lua original
    if (ch < 0 || ch >= NUM_CHANNELS) throw new Error(`bad channel ${ch1}`);
    const cfg = this.channels[ch];

    // Accept scalar | Sequins | sum(a, b). Plain inputs reset the B layer to
    // sequins([0]) so a single-layer launch always lands in a clean state —
    // otherwise a leftover B from a previous run would silently colour the
    // new pattern.
    const apply = <K extends 'div' | 'reps' | 'note' | 'level' | 'harm' | 'env'>(
      key: K,
      v: LaunchVal | undefined,
    ): boolean => {
      if (v === undefined) return false;
      const bKey = `${key}B` as const;
      if (isSumLayers<number>(v)) {
        cfg[key] = v.a;
        cfg[bKey] = v.b;
      } else {
        cfg[key] = asSeq(v);
        cfg[bKey] = sequins([0]);
      }
      return true;
    };

    apply('div',   opts.div);
    apply('reps',  opts.reps);
    if (apply('note', opts.note)) cfg.noteMute = []; // fresh note → fully unmuted
    apply('level', opts.level);
    apply('harm',  opts.harm);
    apply('env',   opts.env);

    const token = ++this.tokens[ch];
    this.running[ch] = true;
    this.emit({ type: 'launch', ch });
    void this.runChannel(ch, token);
  }

  stop(ch1: number): void {
    const ch = ch1 - 1;
    if (ch < 0 || ch >= NUM_CHANNELS) return;
    this.tokens[ch]++;
    if (this.running[ch]) {
      this.running[ch] = false;
      this.emit({ type: 'stop', ch });
    }
  }

  stopAll(): void {
    for (let i = 1; i <= NUM_CHANNELS; i++) this.stop(i);
  }

  private emit(ev: BurstEvent): void {
    for (const fn of this.listeners) fn(ev);
  }

  // Outer loop, mirrors `launch`'s while-true in the Lua: keep firing bursts
  // until either reps becomes finite-AND the user supplied a length-1 reps
  // sequins (single-shot semantics), or we get cancelled.
  private async runChannel(ch: number, token: number): Promise<void> {
    // Anchor the channel to the global clock at the launchGrid resolution.
    // Without this, target = getBeats() captures the user-click instant, and
    // two launches a few ms apart end up with permanently-offset phases.
    let target = snapBeat(getBeats(), this.launchGrid);
    while (this.tokens[ch] === token) {
      const r = await this.runBurst(ch, token, target);
      if (r === null) return;
      target = r.target;
      // Single-shot: A's reps is length-1 AND B's reps is length-1. A
      // multi-step B-reps layer is a clear "make this a loop" signal even if
      // A is single-step.
      const c = this.channels[ch];
      const repsLen = Math.max(c.reps.length, c.repsB.length);
      if (r.reps !== -1 && repsLen <= 1) {
        if (this.tokens[ch] === token) {
          this.running[ch] = false;
          this.emit({ type: 'stop', ch });
        }
        return;
      }
    }
  }

  // Inner burst, mirrors Lua `burst`: capture sequins refs, draw one value
  // each, fire `reps` events spaced by 4/div beats. If any captured ref is
  // replaced (via launch()), bail and let the outer loop redraw fresh values.
  private async runBurst(
    ch: number,
    token: number,
    targetIn: number,
  ): Promise<{ reps: number; div: number; target: number } | null> {
    let target = targetIn;
    while (this.tokens[ch] === token) {
      const cfg = this.channels[ch];
      const divSeq = cfg.div, repsSeq = cfg.reps, noteSeq = cfg.note;
      const divSeqB = cfg.divB, repsSeqB = cfg.repsB, noteSeqB = cfg.noteB;
      // div is clamped to >= 1 — div=0 from a hostile B value would make
      // `target += 4 / div` Infinity-loop with no audible output.
      const div = Math.max(1, divSeq.next() + divSeqB.next());
      // -1 (infinite) on A wins outright; otherwise B is a plain offset.
      const repsA = repsSeq.next();
      const repsBval = repsSeqB.next();
      const reps = repsA === -1 ? -1 : repsA + repsBval;
      // Capture the note position BEFORE next() advances the cursor; this is
      // the index whose mute state gates this burst. Mute keys off A only —
      // B has no parallel mask.
      const noteIdx = (noteSeq.index) % Math.max(noteSeq.length, 1);
      const degree = noteSeq.next() + noteSeqB.next();
      const level = cfg.level.next() + cfg.levelB.next();
      const harm = cfg.harm.next() + cfg.harmB.next();
      const env = cfg.env.next() + cfg.envB.next();
      const freq = degreeToFreq(degree, this.scale);
      const muted = cfg.noteMute[noteIdx] === true;
      const total = reps === -1 ? Infinity : reps;

      let restarted = false;
      for (let i = 0; i < total && this.tokens[ch] === token; i++) {
        // identity check: if launch() replaced any timing/position sequins
        // (A or B), restart this burst so the new values take effect now.
        if (cfg.div !== divSeq || cfg.reps !== repsSeq || cfg.note !== noteSeq ||
            cfg.divB !== divSeqB || cfg.repsB !== repsSeqB || cfg.noteB !== noteSeqB) {
          restarted = true;
          break;
        }
        await waitUntilBeat(target, this.quantize);
        if (this.tokens[ch] !== token) return null;
        if (muted) {
          // Emit a fire event so the playhead still advances, but skip the
          // voice trigger — the note is silent at this position.
          this.emit({ type: 'fire', ch, beat: target, freq, level });
        } else {
          this.fire(ch, target, freq, level, harm, env, div, total, i);
        }
        target += 4 / div;
      }

      if (this.tokens[ch] !== token) return null;
      if (!restarted) return { reps, div, target };
    }
    return null;
  }

  private fire(ch: number, beat: number, freq: number, level: number, harm: number, env: number, div: number, total: number, hitIdx: number): void {
    const actualLevel = this.geodeMode !== 0
      ? geodeAmplitude(this.geodeMode as 1 | 2 | 3, level, hitIdx, total)
      : level;
    let decaySec: number | undefined;
    if (this.envMode !== 0) {
      const secPerBeat = 60 / Tone.Transport.bpm.value;
      const intervalSec = (4 / div) * secPerBeat;
      decaySec = this.envMode === 1 && total !== Infinity
        ? total * intervalSec
        : intervalSec;
    }
    this.voices[ch].triggerAt(Tone.now(), freq, actualLevel, harm, env, decaySec);
    this.emit({ type: 'fire', ch, beat, freq, level: actualLevel });
  }
}
