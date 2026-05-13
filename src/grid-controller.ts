import { BurstEngine, ChannelState, NUM_CHANNELS } from './burst';
import { Grid, GRID_W } from './grid';
import { Sequins, sequins } from './sequins';
import { scales, ScaleName } from './scales';

// Layout reference:
//   rows 0..5 = per-channel step view: cols 0..7 = A layer · cols 8..15 = B layer
//   row 6     = 0..5 launch · 6..11 dark · 12 KB · 13 PROB · 14 QNT · 15 SND
//   row 7     = 0..5 param (div/reps/note/level/harm/env) · 6 scale · 7-8 dark
//             · 9 CLR · 10-13 dark · 14 RANDOMIZE · 15 MUTATE
//
// Display modes (row 6 right side — latch, mutually exclusive):
//   PROB (col 13): rows 0-5 each show a probability slider for that channel
//     cols 0..14 = burst probability 0-100% · col 15 = burst/hit toggle
//   QNT (col 14): opens the scale+quantize picker (same as row 7 col 6)
//   SND (col 15): rows 0-5 each show env (cols 0-2) and geode (cols 4-7) per channel
//
// Row 7 action modes (momentary — arm, then tap a channel in row 6):
//   CLR (col 9):        clear selected param (A+B) for a channel → tap row 6 to pick
//   LOCK (col 10):      toggle locked mode per channel (persistent — stays armed for multi-channel)
//   RANDOMIZE (col 14): replace A-layer with fresh random values
//   MUTATE (col 15):    nudge existing A-layer values
//
// KEYBOARD MODE (row 6 col 12) — gestural sequence programming
//   Page 1: rows 0..1 = note · rows 2..3 = div · rows 4..5 = reps (32 values each)
//   Page 2: rows 0..1 = level · rows 2..3 = harm · rows 4..5 = env (32 values each)
//   Row 6:  cols 0..7 = scale select · cols 8..15 = dark
//   Row 7:  cols 0..5 = channel select (tap again = toggle A/B · slow-strobes on B)
//           col 12 = commit/exit (fast-strobes) · col 13 = page toggle · col 14 = clear buffers
//
// PICKERS (rows 0..1, momentary):
//   step picker  — tap a step on rows 0..5
//   scale picker — tap row 7 col 6
//

type ParamName = 'div' | 'reps' | 'note' | 'level' | 'harm' | 'env';
const PARAMS: ParamName[] = ['div', 'reps', 'note', 'level', 'harm', 'env'];

// Row 7 buttons
const SCALE_BUTTON_COL     = 6;
const CLR_BUTTON_COL       = 9;   // clear selected param on a channel
const LOCK_BUTTON_COL      = 10;  // toggle locked (equal-length) mode per channel
const RANDOMIZE_BUTTON_COL = 14;
const MUTATE_BUTTON_COL    = 15;

// Row 6 right side — mode access (cols 12-15, freed from scenes stub)
const ROW6_KB_COL   = 12;
const ROW6_PROB_COL = 13;
const ROW6_QNT_COL  = 14;
const ROW6_SND_COL  = 15;

// Within KB mode, row 7 controls (col numbers, not row 6)
const KB_EXIT_COL  = 12;
const KB_PAGE_BUTTON_COL  = 13;
const KB_CLEAR_BUTTON_COL = 14;

// 8 scales shown in KB modifier row (row 6, cols 0..7).
const KB_SCALE_NAMES: readonly ScaleName[] = [
  'chromatic', 'major', 'minor', 'pentatonic', 'dorian', 'akebono', 'hijaz', 'kurd',
];

// Scale picker: all 12 scales on a single row (cols 0-11, cols 12-15 dark).
const SCALE_NAMES: readonly ScaleName[] = [
  'chromatic', 'major', 'minor', 'pentatonic', 'dorian',
  'akebono', 'hijaz', 'kurd', 'bayati', 'rast', 'zen', 'wuSheng',
];

// Quantize: 1-16 events per whole note, one value per grid column.
const QUANTIZE_VALUES: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];

const ENV_MODE_NAMES:   readonly string[] = ['shape', 'burst', 'hit'];
const GEODE_MODE_NAMES: readonly string[] = ['off', 'transient', 'sustain', 'cycle'];

// Default value used when a tap appends a new step.
const DEFAULT_VALUE: Record<ParamName, number> = {
  div: 4,
  reps: 1,
  note: 0,
  level: 0.5,
  harm: 2,
  env: 0,
};

// B-layer append default. Zero across the board: B is the additive offset, so
// 0 is the no-op identity. A new step is silent until the user picks a value.
const DEFAULT_VALUE_B: Record<ParamName, number> = {
  div: 0, reps: 0, note: 0, level: 0, harm: 0, env: 0,
};

type Layer = 'A' | 'B';
const defaultAppend = (param: ParamName, layer: Layer): number =>
  layer === 'A' ? DEFAULT_VALUE[param] : DEFAULT_VALUE_B[param];

const STEP_PICKER_VALUES: Record<ParamName, number[]> = {
  div:   Array.from({ length: 32 }, (_, i) => i + 1),
  reps: [...Array.from({ length: 31 }, (_, i) => i + 1), -1],
  note:  Array.from({ length: 32 }, (_, i) => i),
  level: Array.from({ length: 32 }, (_, i) => (i + 1) / 32),
  // 32 evenly-spaced ratios from 2.0..4.0 inclusive (step ≈ 0.0645).
  // Index 0 = 2 (default), index 31 = 4 (max inharmonic).
  harm:  Array.from({ length: 32 }, (_, i) => 2 + (i / 31) * 16),
  // 32 evenly-spaced env shape values 0..1. 0 = snappy default, 1 = longest
  // still-percussive setting (~25ms attack, ~1.2s decay).
  env:   Array.from({ length: 32 }, (_, i) => i / 31),
};

function valueBrightness(param: ParamName, value: number): number {
  switch (param) {
    case 'div':   return value <= 4 ? 6 : value <= 8 ? 8 : value <= 16 ? 11 : 14;
    case 'reps':  return value === -1 ? 15 : Math.min(4 + value, 14);
    case 'note':  return Math.min(4 + Math.abs(value), 15);
    case 'level': return Math.max(2, Math.round(2 + value * 13));
    case 'harm': {
      // Brighter for more inharmonic ratios (further from 2). Clamped so
      // off-range values (set via REPL) still render visibly.
      const norm = (value - 2) / 2;        // 0..1 across 2..4
      return Math.max(4, Math.min(14, Math.round(4 + norm * 10)));
    }
    case 'env': {
      // Brighter for longer envelopes — the visual hint is "more energy in
      // the tail." Clamped so out-of-range REPL values still render.
      const norm = Math.max(0, Math.min(1, value));
      return Math.max(2, Math.min(14, Math.round(2 + norm * 12)));
    }
    default:      return 6;
  }
}

const eq = (a: number, b: number) => Math.abs(a - b) < 1e-6;

type Picker =
  | { kind: 'step'; ch: number; col: number; layer: Layer }
  | { kind: 'scale' };

export class GridController {
  private engine: BurstEngine;
  private grid: Grid;
  private selectedParam: ParamName = 'note';
  private picker: Picker | null = null;
  private probMode     = false;
  private soundMode    = false;
  private actionMode: 'randomize' | 'mutate' | 'clear' | 'lock' | null = null;
  private statusEl: HTMLElement | null;

  private paramLayer: Layer = 'A';

  private kbMode      = false;
  private kbPage: 1 | 2 = 1;
  private kbBLayer    = false;
  private kbChannel   = 0;
  private kbNoteBuffer:  number[] = [];
  private kbDivBuffer:   number[] = [];
  private kbRepBuffer:   number[] = [];
  private kbLevelBuffer: number[] = [];
  private kbHarmBuffer:  number[] = [];
  private kbEnvBuffer:   number[] = [];

  constructor(engine: BurstEngine, grid: Grid) {
    this.engine = engine;
    this.grid = grid;
    this.statusEl = document.getElementById('status');

    grid.onPress((x, y) => this.handlePress(x, y));

    engine.on(ev => {
      switch (ev.type) {
        case 'fire':
          if (this.kbMode) return;
          if (this.picker && ev.ch < 2) return;
          this.renderChannelRow(ev.ch);
          break;
        case 'launch':
        case 'stop':
          this.renderAll();
          break;
      }
    });

    this.renderAll();
  }

  refresh(): void { this.renderAll(); }

  // ---- press dispatch ---------------------------------------------------

  private handlePress(x: number, y: number): void {
    if (this.kbMode) { this.handleKbPress(x, y); return; }
    if (this.picker) this.handlePickerPress(x, y);
    else            this.handleNormalPress(x, y);
  }

  private handleNormalPress(x: number, y: number): void {
    if (y < 6) {
      if (this.probMode) {
        const ch = this.engine.channels[y];
        if (x === 15) {
          ch.probHit = !ch.probHit;
          console.log(`[ch${y + 1} prob] ${ch.probHit ? 'per-hit' : 'burst'}`);
        } else {
          ch.burstProb = x / 14;
          console.log(`[ch${y + 1} prob] ${(x / 14).toFixed(2)}`);
        }
        this.renderChannelRow(y);
        return;
      }
      if (this.soundMode) {
        const ch = this.engine.channels[y];
        if (x <= 2) {
          ch.envMode = x as 0 | 1 | 2;
          console.log(`[ch${y + 1} env] ${ENV_MODE_NAMES[x]}`);
        } else if (x >= 4 && x <= 7) {
          ch.geodeMode = (x - 4) as 0 | 1 | 2 | 3;
          console.log(`[ch${y + 1} geode] ${GEODE_MODE_NAMES[x - 4]}`);
        }
        this.renderChannelRow(y);
        return;
      }
      this.openStepPicker(y, x);
    } else if (y === 6) {
      this.handleRow6(x);
    } else if (y === 7) {
      this.handleRow7(x);
    }
  }

  private handlePickerPress(x: number, y: number): void {
    const p = this.picker!;

    if (y < 2) {
      this.applyPickerValue(p, x, y);
      return;
    }

    if (p.kind === 'step' && y < 6) {
      const rawCol = p.col;
      if (y === p.ch && x === rawCol) {
        this.removeStep(p.ch, p.col, p.layer);
        this.closePicker();
      } else {
        this.openStepPicker(y, x);
      }
      return;
    }

    if (y === 7 && p.kind === 'scale' && x === SCALE_BUTTON_COL) {
      this.closePicker();
      return;
    }

    this.closePicker();
    this.handleNormalPress(x, y);
  }

  // ---- value application ------------------------------------------------

  private applyPickerValue(p: Picker, x: number, y: number): void {
    if (p.kind === 'step') {
      const v = STEP_PICKER_VALUES[this.selectedParam][y * GRID_W + x];
      this.setStep(p.ch, p.col, v, p.layer);
      this.closePicker();
    } else if (p.kind === 'scale') {
      if (y === 0) {
        const name = SCALE_NAMES[x];
        if (!name) return;
        this.engine.scale = scales[name];
        console.log(`[scale] ${name}`);
        this.closePicker();
      } else { // y === 1: quantize row
        const v = QUANTIZE_VALUES[x];
        this.engine.quantize = v;
        console.log(`[quantize] ${v}`);
        this.renderAll();
      }
    }
  }

  // ---- picker enter/exit -------------------------------------------------

  private openStepPicker(ch: number, col: number): void {
    const param = this.selectedParam;
    const layer = this.paramLayer;
    const stepIdx = col;
    const cur = this.seqRef(ch, param, layer).values;
    if (stepIdx === cur.length) {
      if (cur.length >= GRID_W) return;  // layer is at capacity
      const next = cur.slice();
      next.push(defaultAppend(param, layer));
      this.commitStep(ch, param, next, layer);
      this.picker = { kind: 'step', ch, col: stepIdx, layer };
    } else if (stepIdx < cur.length) {
      this.picker = { kind: 'step', ch, col: stepIdx, layer };
    } else {
      return;
    }
    this.renderAll();
    this.updateStatus();
  }

  private openScalePicker(): void {
    this.picker = { kind: 'scale' };
    this.renderAll();
    this.updateStatus();
  }

  private closePicker(): void {
    this.picker = null;
    this.renderAll();
    this.updateStatus();
  }

  // ---- step mutations ---------------------------------------------------

  // Read the (A or B) sequins for a channel/param. Centralised so the
  // string-templated B-field name (`${param}B`) stays in one place.
  private seqRef(ch: number, param: ParamName, layer: Layer): Sequins<number> {
    const c = this.engine.channels[ch];
    if (layer === 'A') return c[param];
    const key = (param + 'B') as keyof ChannelState;
    return c[key] as Sequins<number>;
  }

  private setStep(ch: number, col: number, value: number, layer: Layer): void {
    const param = this.selectedParam;
    const next = this.seqRef(ch, param, layer).values.slice();
    next[col] = value;
    this.commitStep(ch, param, next, layer);
  }

  private removeStep(ch: number, col: number, layer: Layer): void {
    const param = this.selectedParam;
    const next = this.seqRef(ch, param, layer).values.slice();
    next.splice(col, 1);
    this.commitStep(ch, param, next, layer);
  }

  private commitStepRaw(ch: number, param: ParamName, vals: number[], layer: Layer): void {
    const final = vals.length === 0 ? [defaultAppend(param, layer)] : vals;
    const c = this.engine.channels[ch];
    if (layer === 'A') {
      c[param] = sequins(final);
    } else {
      const key = (param + 'B') as keyof ChannelState;
      (c as unknown as Record<string, Sequins<number>>)[key] = sequins(final);
    }
    const logVals = param === 'env' ? final.map(v => Math.round(v * 31)) : final;
    console.log(`[ch${ch + 1} ${param}${layer === 'B' ? 'B' : ''}] s(${JSON.stringify(logVals)})`);
  }

  private commitStep(ch: number, param: ParamName, vals: number[], layer: Layer): void {
    const oldLen = this.seqRef(ch, param, layer).values.length;
    this.commitStepRaw(ch, param, vals, layer);
    const newLen = Math.max(1, vals.length);
    if (this.engine.channels[ch].locked && layer === 'A' && newLen !== oldLen) {
      this.syncLockedParams(ch, newLen, param);
    }
  }

  private syncLockedParams(ch: number, targetLen: number, skipParam: ParamName | null): void {
    for (const param of PARAMS) {
      if (param === skipParam) continue;
      const cur = this.seqRef(ch, param, 'A').values;
      if (cur.length === targetLen) continue;
      const next = targetLen > cur.length
        ? [...cur, ...Array(targetLen - cur.length).fill(cur[cur.length - 1])]
        : cur.slice(0, targetLen);
      this.commitStepRaw(ch, param, next, 'A');
    }
  }

  private enforceLockOnEntry(ch: number): void {
    const maxLen = Math.max(...PARAMS.map(p => this.seqRef(ch, p, 'A').values.length));
    this.syncLockedParams(ch, maxLen, null);
  }

  // ---- clear -------------------------------------------------------------

  // Reset the selected param's A and B sequences on `ch` to single-value
  // defaults (effectively clearing whatever pattern was there).
  private clearChannelParam(ch: number): void {
    const param = this.selectedParam;
    const c = this.engine.channels[ch];
    c[param] = sequins([DEFAULT_VALUE[param]]);
    const bKey = `${param}B` as keyof ChannelState;
    (c as unknown as Record<string, Sequins<number>>)[bKey] = sequins([0]);
    console.log(`[clear] ch${ch + 1} ${param}`);
    this.renderAll();
  }

  // ---- row 6 / row 7 -----------------------------------------------------

  private handleRow6(x: number): void {
    // Mode access buttons (right side, always available)
    if (x === ROW6_KB_COL)   { this.enterKbMode(); return; }
    if (x === ROW6_PROB_COL) {
      this.probMode = !this.probMode;
      if (this.probMode) { this.soundMode = false; this.actionMode = null; }
      this.renderAll(); this.updateStatus(); return;
    }
    if (x === ROW6_QNT_COL) {
      this.openScalePicker(); return;
    }
    if (x === ROW6_SND_COL) {
      this.soundMode = !this.soundMode;
      if (this.soundMode) { this.probMode = false; this.actionMode = null; }
      this.renderAll(); this.updateStatus(); return;
    }

    if (this.actionMode === 'lock' && x < 6) {
      const c = this.engine.channels[x];
      c.locked = !c.locked;
      if (c.locked) this.enforceLockOnEntry(x);
      console.log(`[lock] ch${x + 1} ${c.locked ? 'on' : 'off'}`);
      this.renderAll(); this.updateStatus(); return;
    }

    if (this.actionMode && x < 6) {
      const ch1 = x + 1;
      if (this.actionMode === 'randomize') {
        this.engine.randomize(ch1);
        console.log(`[randomize] ch${ch1}`);
      } else if (this.actionMode === 'mutate') {
        this.engine.mutate(ch1);
        console.log(`[mutate] ch${ch1}`);
      } else if (this.actionMode === 'clear') {
        this.clearChannelParam(x);
      }
      this.actionMode = null;
      this.renderAll(); this.updateStatus(); return;
    }

    if (x < 6) {
      const ch1 = x + 1;
      if (this.engine.isRunning(x)) this.engine.stop(ch1);
      else this.engine.launch(ch1);
    }
    // cols 6-11 unused
  }

  private handleRow7(x: number): void {
    if (x < PARAMS.length) {
      if (PARAMS[x] === this.selectedParam) {
        this.paramLayer = this.paramLayer === 'A' ? 'B' : 'A';
      } else {
        this.selectedParam = PARAMS[x];
        this.paramLayer = 'A';
      }
      this.picker = null;
      this.renderAll();
      this.updateStatus();
    } else if (x === SCALE_BUTTON_COL) {
      this.openScalePicker();
    } else if (x === CLR_BUTTON_COL) {
      this.actionMode = this.actionMode === 'clear' ? null : 'clear';
      if (this.actionMode) { this.probMode = false; this.soundMode = false; }
      this.renderAll();
      this.updateStatus();
    } else if (x === LOCK_BUTTON_COL) {
      this.actionMode = this.actionMode === 'lock' ? null : 'lock';
      if (this.actionMode) { this.probMode = false; this.soundMode = false; }
      this.renderAll();
      this.updateStatus();
    } else if (x === RANDOMIZE_BUTTON_COL) {
      this.actionMode = this.actionMode === 'randomize' ? null : 'randomize';
      if (this.actionMode) { this.probMode = false; this.soundMode = false; }
      this.renderAll();
      this.updateStatus();
    } else if (x === MUTATE_BUTTON_COL) {
      this.actionMode = this.actionMode === 'mutate' ? null : 'mutate';
      if (this.actionMode) { this.probMode = false; this.soundMode = false; }
      this.renderAll();
      this.updateStatus();
    }
    // cols 7-8 and 10-13 are dark/unhandled
  }

  // ---- rendering ---------------------------------------------------------

  private renderAll(): void {
    if (this.kbMode) { this.renderKbMode(); return; }
    this.grid.clear();
    if (this.picker) {
      this.renderPicker();
      for (let ch = 2; ch < NUM_CHANNELS; ch++) this.renderChannelRow(ch);
    } else {
      for (let ch = 0; ch < NUM_CHANNELS; ch++) this.renderChannelRow(ch);
    }
    this.renderRow6();
    this.renderRow7();
  }

  private renderPicker(): void {
    if (!this.picker) return;
    switch (this.picker.kind) {
      case 'step':  this.renderStepPicker(this.picker); break;
      case 'scale': this.renderScalePicker(); break;
    }
  }

  private renderStepPicker(p: { kind: 'step'; ch: number; col: number; layer: Layer }): void {
    const param = this.selectedParam;
    const seq = this.seqRef(p.ch, param, p.layer);
    const vals = seq.values;
    const focused = vals[p.col];
    const layout = STEP_PICKER_VALUES[param];

    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const v = layout[y * GRID_W + x];
        let b: number;
        if (eq(v, focused))                  b = 15;
        else if (vals.some(sv => eq(sv, v))) b = 5;
        else                                  b = 1;
        this.grid.setLed(x, y, b);
      }
    }
  }

  private renderScalePicker(): void {
    const active = this.engine.scale;
    for (let x = 0; x < GRID_W; x++) {
      const name = SCALE_NAMES[x];
      let b: number;
      if (!name)                        b = 0;
      else if (scales[name] === active) b = 15;
      else                              b = 5;
      this.grid.setLed(x, 0, b);
    }
    const curQ = this.engine.quantize;
    for (let x = 0; x < GRID_W; x++) {
      this.grid.setLed(x, 1, QUANTIZE_VALUES[x] === curQ ? 15 : 3);
    }
  }

  private renderChannelRow(ch: number): void {
    if (this.probMode)  { this.renderProbRow(ch); return; }
    if (this.soundMode) { this.renderSoundRow(ch); return; }
    const param = this.selectedParam;
    const layer = this.paramLayer;
    const seq = this.seqRef(ch, param, layer);
    const vals = seq.values;

    for (let i = 0; i < GRID_W; i++) {
      if (i < vals.length) {
        this.grid.setLed(i, ch, valueBrightness(param, vals[i]));
        this.grid.setStrobe(i, ch, 'off');
      } else if (i === vals.length && vals.length < GRID_W) {
        this.grid.setLed(i, ch, 1);
        this.grid.setStrobe(i, ch, 'off');
      } else {
        this.grid.setLed(i, ch, 0);
        this.grid.setStrobe(i, ch, 'off');
      }
    }

    if (this.engine.isRunning(ch) && vals.length > 0) {
      const playhead = (seq.index - 1 + vals.length) % vals.length;
      this.grid.setLed(playhead, ch, 15);
    }

    if (this.picker?.kind === 'step' && this.picker.ch === ch && this.picker.layer === layer) {
      this.grid.setLed(this.picker.col, ch, 15);
    }
  }

  private renderProbRow(ch: number): void {
    const state = this.engine.channels[ch];
    const col = Math.round(state.burstProb * 14);
    for (let i = 0; i < 15; i++) {
      this.grid.setLed(i, ch, i === col ? 15 : 1);
      this.grid.setStrobe(i, ch, 'off');
    }
    // Col 15: burst/hit toggle — dim=burst, bright=hit, slow-strobes when hit mode active
    this.grid.setLed(15, ch, state.probHit ? 14 : 4);
    this.grid.setStrobe(15, ch, state.probHit ? 'slow' : 'off');
  }

  private renderSoundRow(ch: number): void {
    const { envMode, geodeMode } = this.engine.channels[ch];
    for (let x = 0; x < GRID_W; x++) {
      this.grid.setLed(x, ch, 0);
      this.grid.setStrobe(x, ch, 'off');
    }
    for (let m = 0; m < 3; m++) this.grid.setLed(m, ch, envMode === m ? 15 : 4);
    // col 3 = dark separator
    for (let m = 0; m < 4; m++) this.grid.setLed(m + 4, ch, geodeMode === m ? 15 : 4);
  }

  private renderActionMode(): void {
    for (let x = 0; x < 6; x++) {
      const b = this.actionMode === 'lock'
        ? (this.engine.channels[x].locked ? 15 : 4)
        : 10;
      this.grid.setLed(x, 6, b);
    }
    for (let x = 6; x < 12; x++) this.grid.setLed(x, 6, 0);
    // Keep mode buttons visible at mid brightness during action mode
    this.grid.setLed(ROW6_KB_COL,   6, 8);
    this.grid.setLed(ROW6_PROB_COL, 6, 8);
    this.grid.setLed(ROW6_QNT_COL,  6, 8);
    this.grid.setLed(ROW6_SND_COL,  6, 8);
  }

  private renderRow6(): void {
    if (this.actionMode) {
      this.renderActionMode();
    } else {
      for (let x = 0; x < 6; x++) {
        this.grid.setLed(x, 6, this.engine.isRunning(x) ? 15 : 4);
      }
      for (let x = 6; x < 12; x++) this.grid.setLed(x, 6, 0);
    }
    // Mode access buttons always visible (cols 12-15)
    this.grid.setLed(ROW6_KB_COL, 6, 8);
    this.grid.setLed(ROW6_PROB_COL, 6, this.probMode ? 15 : 8);
    this.grid.setStrobe(ROW6_PROB_COL, 6, this.probMode ? 'fast' : 'off');
    this.grid.setLed(ROW6_QNT_COL, 6, 8);
    this.grid.setLed(ROW6_SND_COL, 6, this.soundMode ? 15 : 8);
    this.grid.setStrobe(ROW6_SND_COL, 6, this.soundMode ? 'fast' : 'off');
  }

  private renderRow7(): void {
    // Params 0-5
    for (let x = 0; x < PARAMS.length; x++) {
      const isSelected = PARAMS[x] === this.selectedParam;
      this.grid.setLed(x, 7, isSelected ? 15 : 5);
      this.grid.setStrobe(x, 7, isSelected && this.paramLayer === 'B' ? 'slow' : 'off');
    }
    // Scale picker
    this.grid.setLed(SCALE_BUTTON_COL, 7, this.picker?.kind === 'scale' ? 15 : 8);
    // Dark gaps at 7, 8
    this.grid.setLed(7, 7, 0);
    this.grid.setLed(8, 7, 0);
    // Clear (arms pick-a-channel mode)
    this.grid.setLed(CLR_BUTTON_COL, 7, this.actionMode === 'clear' ? 15 : 4);
    this.grid.setStrobe(CLR_BUTTON_COL, 7, this.actionMode === 'clear' ? 'fast' : 'off');
    // Lock (toggle per-channel locked mode)
    this.grid.setLed(LOCK_BUTTON_COL, 7, this.actionMode === 'lock' ? 15 : 4);
    this.grid.setStrobe(LOCK_BUTTON_COL, 7, this.actionMode === 'lock' ? 'fast' : 'off');
    // Dark gaps at 11-13
    for (let x = 11; x < 14; x++) this.grid.setLed(x, 7, 0);
    // Randomize and Mutate
    this.grid.setLed(RANDOMIZE_BUTTON_COL, 7, this.actionMode === 'randomize' ? 15 : 4);
    this.grid.setStrobe(RANDOMIZE_BUTTON_COL, 7, this.actionMode === 'randomize' ? 'fast' : 'off');
    this.grid.setLed(MUTATE_BUTTON_COL, 7, this.actionMode === 'mutate' ? 15 : 4);
    this.grid.setStrobe(MUTATE_BUTTON_COL, 7, this.actionMode === 'mutate' ? 'fast' : 'off');
  }

  // ---- keyboard mode -----------------------------------------------------

  private enterKbMode(): void {
    this.kbMode = true;
    this.kbPage = 1;
    this.kbBLayer = false;
    this.kbChannel = 0;
    this.clearKbBuffers();
    this.renderAll();
    this.updateStatus();
  }

  private exitKbMode(): void {
    this.commitKbBuffers(this.kbChannel);
    this.kbMode = false;
    this.renderAll();
    this.updateStatus();
  }

  private clearKbBuffers(): void {
    this.kbNoteBuffer  = [];
    this.kbDivBuffer   = [];
    this.kbRepBuffer   = [];
    this.kbLevelBuffer = [];
    this.kbHarmBuffer  = [];
    this.kbEnvBuffer   = [];
  }

  private commitKbBuffers(ch: number): void {
    const layer: Layer = this.kbBLayer ? 'B' : 'A';
    if (this.kbNoteBuffer.length)  this.commitStep(ch, 'note',  this.kbNoteBuffer,  layer);
    if (this.kbDivBuffer.length)   this.commitStep(ch, 'div',   this.kbDivBuffer,   layer);
    if (this.kbRepBuffer.length) {
      // A length-1 finite reps sequin triggers single-shot semantics in
      // runChannel (burst.ts:236). In KB mode the intent is always to loop, so
      // duplicate a solitary finite value to make the sequin length-2.
      const buf = this.kbRepBuffer;
      const safe = layer === 'A' && buf.length === 1 && buf[0] !== -1 ? [buf[0], buf[0]] : buf;
      this.commitStep(ch, 'reps', safe, layer);
    }
    if (this.kbLevelBuffer.length) this.commitStep(ch, 'level', this.kbLevelBuffer, layer);
    if (this.kbHarmBuffer.length)  this.commitStep(ch, 'harm',  this.kbHarmBuffer,  layer);
    if (this.kbEnvBuffer.length)   this.commitStep(ch, 'env',   this.kbEnvBuffer,   layer);
  }

  private switchKbChannel(ch: number): void {
    this.commitKbBuffers(this.kbChannel);
    this.clearKbBuffers();
    this.kbChannel = ch;
    this.renderAll();
    this.updateStatus();
  }

  private handleKbPress(x: number, y: number): void {
    if (y === 7) {
      if (x < 6) {
        if (x === this.kbChannel) {
          this.kbBLayer = !this.kbBLayer;
          this.clearKbBuffers();
          this.renderAll();
          this.updateStatus();
        } else {
          this.switchKbChannel(x);
        }
        return;
      }
      if (x === KB_EXIT_COL)  { this.exitKbMode(); return; }
      if (x === KB_PAGE_BUTTON_COL)  {
        this.kbPage = this.kbPage === 1 ? 2 : 1;
        this.renderAll();
        this.updateStatus();
        return;
      }
      if (x === KB_CLEAR_BUTTON_COL) { this.clearKbBuffers(); this.renderAll(); return; }
      return;
    }

    if (y === 6) {
      const name = KB_SCALE_NAMES[x];
      if (name) { this.engine.scale = scales[name]; console.log(`[kb scale] ${name}`); }
      this.renderAll();
      return;
    }

    if (y < 6 && this.kbPage === 1) {
      if (y < 2) {
        const v = STEP_PICKER_VALUES['note'][y * GRID_W + x];
        this.kbNoteBuffer.push(v);
        console.log(`[kb note] ${v} len=${this.kbNoteBuffer.length}`);
      } else if (y < 4) {
        const v = STEP_PICKER_VALUES['div'][(y - 2) * GRID_W + x];
        this.kbDivBuffer.push(v);
        console.log(`[kb div] ${v} len=${this.kbDivBuffer.length}`);
      } else {
        const v = STEP_PICKER_VALUES['reps'][(y - 4) * GRID_W + x];
        this.kbRepBuffer.push(v);
        console.log(`[kb rep] ${v} len=${this.kbRepBuffer.length}`);
      }
      this.commitKbBuffers(this.kbChannel);
      this.renderAll();
      return;
    }

    if (y < 6 && this.kbPage === 2) {
      if (y < 2) {
        const v = STEP_PICKER_VALUES['level'][y * GRID_W + x];
        this.kbLevelBuffer.push(v);
        console.log(`[kb level] ${v.toFixed(3)} len=${this.kbLevelBuffer.length}`);
      } else if (y < 4) {
        const v = STEP_PICKER_VALUES['harm'][(y - 2) * GRID_W + x];
        this.kbHarmBuffer.push(v);
        console.log(`[kb harm] ${v.toFixed(3)} len=${this.kbHarmBuffer.length}`);
      } else {
        const v = STEP_PICKER_VALUES['env'][(y - 4) * GRID_W + x];
        this.kbEnvBuffer.push(v);
        console.log(`[kb env] ${Math.round(v * 31)} len=${this.kbEnvBuffer.length}`);
      }
      this.commitKbBuffers(this.kbChannel);
      this.renderAll();
    }
  }

  private renderKbMode(): void {
    this.grid.clear();
    if (this.kbPage === 1) this.renderKbPage1();
    else                   this.renderKbPage2();
    this.renderKbModifierRow();
    this.renderKbRow7();
  }

  private renderKbPage1(): void {
    const layer: Layer = this.kbBLayer ? 'B' : 'A';
    const existingNote = this.seqRef(this.kbChannel, 'note', layer).values;
    const existingDiv  = this.seqRef(this.kbChannel, 'div',  layer).values;
    const existingReps = this.seqRef(this.kbChannel, 'reps', layer).values;

    const renderBand = (
      rowOffset: number,
      param: 'note' | 'div' | 'reps',
      buffer: number[],
      existing: readonly number[],
    ) => {
      const vals = STEP_PICKER_VALUES[param];
      for (let localRow = 0; localRow < 2; localRow++) {
        for (let col = 0; col < GRID_W; col++) {
          const v = vals[localRow * GRID_W + col];
          let b: number;
          if (buffer.some(bv => eq(bv, v)))        b = 15;
          else if (existing.some(ev => eq(ev, v))) b = 5;
          else                                      b = 2;
          this.grid.setLed(col, rowOffset + localRow, b);
        }
      }
    };

    renderBand(0, 'note', this.kbNoteBuffer, existingNote);
    renderBand(2, 'div',  this.kbDivBuffer,  existingDiv);
    renderBand(4, 'reps', this.kbRepBuffer,  existingReps);
  }

  private renderKbPage2(): void {
    const layer: Layer = this.kbBLayer ? 'B' : 'A';
    const existingLevel = this.seqRef(this.kbChannel, 'level', layer).values;
    const existingHarm  = this.seqRef(this.kbChannel, 'harm',  layer).values;
    const existingEnv   = this.seqRef(this.kbChannel, 'env',   layer).values;

    const renderBand = (
      rowOffset: number,
      param: 'level' | 'harm' | 'env',
      buffer: number[],
      existing: readonly number[],
    ) => {
      const vals = STEP_PICKER_VALUES[param];
      for (let localRow = 0; localRow < 2; localRow++) {
        for (let col = 0; col < GRID_W; col++) {
          const v = vals[localRow * GRID_W + col];
          let b: number;
          if (buffer.some(bv => eq(bv, v)))   b = 15;
          else if (existing.some(ev => eq(ev, v))) b = 5;
          else                                  b = 2;
          this.grid.setLed(col, rowOffset + localRow, b);
        }
      }
    };

    renderBand(0, 'level', this.kbLevelBuffer, existingLevel);
    renderBand(2, 'harm',  this.kbHarmBuffer,  existingHarm);
    renderBand(4, 'env',   this.kbEnvBuffer,   existingEnv);
  }

  private renderKbModifierRow(): void {
    const activeScale = this.engine.scale;
    for (let x = 0; x < 8; x++) {
      const name = KB_SCALE_NAMES[x];
      this.grid.setLed(x, 6, scales[name] === activeScale ? 15 : 8);
    }
    for (let x = 8; x < GRID_W; x++) this.grid.setLed(x, 6, 0);
  }

  private renderKbRow7(): void {
    for (let x = 0; x < 6; x++) {
      const isSelected = x === this.kbChannel;
      this.grid.setLed(x, 7, isSelected ? 15 : 4);
      this.grid.setStrobe(x, 7, isSelected && this.kbBLayer ? 'slow' : 'off');
    }
    for (let x = 6; x < 12; x++) this.grid.setLed(x, 7, 0);
    this.grid.setLed(KB_EXIT_COL,   7, 15);
    this.grid.setStrobe(KB_EXIT_COL, 7, 'fast');
    this.grid.setLed(KB_PAGE_BUTTON_COL,   7, this.kbPage === 1 ? 15 : 8);
    this.grid.setLed(KB_CLEAR_BUTTON_COL,  7, 4);
    for (let x = 15; x < GRID_W; x++) this.grid.setLed(x, 7, 0);
  }

  // ---- rendering ---------------------------------------------------------

  private updateStatus(): void {
    if (!this.statusEl) return;
    if (this.kbMode) {
      const page = this.kbPage === 1
        ? 'pg1: note · div · reps'
        : 'pg2: level · harm · env';
      const counts = this.kbPage === 1
        ? `note:${this.kbNoteBuffer.length} div:${this.kbDivBuffer.length} reps:${this.kbRepBuffer.length}`
        : `level:${this.kbLevelBuffer.length} harm:${this.kbHarmBuffer.length} env:${this.kbEnvBuffer.length}`;
      const layerTag = this.kbBLayer ? ' · B layer (tap channel again for A)' : ' · A layer (tap channel again for B)';
      this.statusEl.textContent =
        `KB MODE ch${this.kbChannel + 1} · ${page}${layerTag} · ${counts} — row7 col12 to commit/exit`;
      return;
    }
    if (this.probMode) {
      const probs = this.engine.channels.map((c, i) =>
        `ch${i + 1}:${Math.round(c.burstProb * 100)}%${c.probHit ? '(hit)' : ''}`).join(' ');
      this.statusEl.textContent =
        `PROB — cols 0-14: probability · col 15: burst/hit toggle · ${probs}`;
      return;
    }
    if (this.soundMode) {
      const info = this.engine.channels.map((c, i) =>
        `ch${i + 1}:${ENV_MODE_NAMES[c.envMode]}/${GEODE_MODE_NAMES[c.geodeMode]}`).join(' ');
      this.statusEl.textContent = `SOUND — cols 0-2: env · cols 4-7: geode · ${info}`;
      return;
    }
    if (this.actionMode === 'lock') {
      const states = this.engine.channels.map((c, i) => `ch${i + 1}:${c.locked ? 'locked' : 'free'}`).join(' ');
      this.statusEl.textContent = `LOCK — tap a channel to toggle · ${states} — tap LOCK again to exit`;
      return;
    }
    if (this.actionMode) {
      const desc = this.actionMode === 'clear'
        ? `CLEAR ${this.selectedParam} — tap a channel`
        : `${this.actionMode.toUpperCase()} — tap a channel`;
      this.statusEl.textContent = `${desc} · tap button again to cancel`;
      return;
    }
    const p = this.picker;
    if (p?.kind === 'step') {
      const raw = this.seqRef(p.ch, this.selectedParam, p.layer).values[p.col];
      const v = this.selectedParam === 'env' ? Math.round(raw * 31) : raw;
      const layerTag = p.layer === 'B' ? `${this.selectedParam}B` : this.selectedParam;
      this.statusEl.textContent =
        `editing ch${p.ch + 1} step ${p.col} ${layerTag}=${v} — pick on rows 0-1, tap step again to remove`;
    } else if (p?.kind === 'scale') {
      this.statusEl.textContent = `row 0: pick a scale · row 1: quantize 1–16 (current: ${this.engine.quantize}) — tap scale button to cancel`;
    } else {
      const layerHint = this.paramLayer === 'B'
        ? `B layer (press ${this.selectedParam} again for A)`
        : `A layer (press ${this.selectedParam} again for B · up to 16 steps)`;
      this.statusEl.textContent = `editing ${this.selectedParam} · ${layerHint}`;
    }
  }
}
