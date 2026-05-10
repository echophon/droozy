import { BurstEngine, ChannelState, NUM_CHANNELS } from './burst';
import { Grid, GRID_W } from './grid';
import { Sequins, sequins } from './sequins';
import { scales, ScaleName } from './scales';

// Layout reference:
//   rows 0..5 = per-channel step view: cols 0..15 = active layer (A or B, up to 16 steps)
//   row 6     = 0..5 launch | 6..11 unused | 12..15 scenes (stub)
//   row 7     = 0..5 param (div/reps/note/level/harm/env)
//             |  press once = select & show A layer
//             |  press again (same param) = toggle to B layer (button strobes)
//             | 6 scale | 7 quantize | 8 MUTE mode | 9 TRUNCATE mode
//             | 10 ENV MODE (dim=shape · mid=burst · bright=hit)
//             | 11 GEODE MODE (off · dim=transient · mid=sustain · bright=cycle)
//             | 12 KB MODE (keyboard mode entry/exit) | 13..15 unused
//
// KEYBOARD MODE (row 7 col 12) — gestural sequence programming
//   Page 1: rows 0..1 = note · rows 2..3 = div · rows 4..5 = reps (32 values each)
//   Page 2: rows 0..1 = level · rows 2..3 = harm · rows 4..5 = env (32 values each)
//   Row 6:  cols 0..7 = scale select · cols 8..15 = dark
//   Row 7:  cols 0..5 = channel select (tap again = toggle A/B layer; button strobes on B)
//            col 12 = KB toggle/commit · col 13 = page toggle · col 14 = clear buffers
//
// PICKERS (rows 0..1, momentary)
//   step picker   — tap a step on rows 0..5 (with mute mode OFF)
//   scale picker  — tap row 7 col 6
//   quantize picker — tap row 7 col 7 (double-click disables instead of opening)
//
// MUTE MODIFIER (row 7 col 8)
//   Tap to latch into mute mode. While latched, taps toggle the noteMute flag
//   at that step — only active when the A layer is selected (mute has no B-layer
//   equivalent). Tap again to exit.

type ParamName = 'div' | 'reps' | 'note' | 'level' | 'harm' | 'env';
const PARAMS: ParamName[] = ['div', 'reps', 'note', 'level', 'harm', 'env'];

const SCALE_BUTTON_COL = 6;
const QUANTIZE_BUTTON_COL = 7;
const MUTE_BUTTON_COL = 8;
const TRUNCATE_BUTTON_COL = 9;
const ENV_MODE_BUTTON_COL = 10;
const ENV_MODE_BRIGHTNESS: readonly number[] = [3, 8, 14];  // shape / burst / hit
const ENV_MODE_NAMES: readonly string[] = ['shape', 'burst', 'hit'];
const GEODE_MODE_BUTTON_COL = 11;
const GEODE_MODE_BRIGHTNESS: readonly number[] = [0, 4, 9, 14]; // off / transient / sustain / cycle
const GEODE_MODE_NAMES: readonly string[] = ['off', 'transient', 'sustain', 'cycle'];

const KB_MODE_BUTTON_COL   = 12;
const KB_PAGE_BUTTON_COL   = 13;
const KB_CLEAR_BUTTON_COL  = 14;

// 8 scales shown in KB modifier row (row 6, cols 0..7).
const KB_SCALE_NAMES: readonly ScaleName[] = [
  'chromatic', 'major', 'minor', 'pentatonic', 'dorian', 'akebono', 'hijaz', 'kurd',
];

const DOUBLE_CLICK_MS = 350;

// Scale picker layout. Two rows split the catalogue by region.
const SCALE_PICKER_ROWS: readonly ScaleName[][] = [
  ['chromatic', 'major', 'minor', 'pentatonic', 'dorian'],
  ['akebono', 'hijaz', 'kurd', 'bayati', 'rast', 'zen', 'wuSheng'],
];

// Every integer 1..32 — odd values reachable for tuplet feels.
const QUANTIZE_PICKER: readonly number[] = Array.from({ length: 32 }, (_, i) => i + 1);

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
  | { kind: 'scale' }
  | { kind: 'quantize' };

export class GridController {
  private engine: BurstEngine;
  private grid: Grid;
  private selectedParam: ParamName = 'note';
  private picker: Picker | null = null;
  private muteMode = false;
  private truncateMode = false;
  private quantizeClickTime = 0;
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
      if (this.truncateMode) {
        this.truncateStep(y, x);
        return;
      }
      if (this.muteMode) {
        this.toggleNoteMute(y, x);
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
        // mute mode while a step picker is open: switch to mute; otherwise re-focus
        if (this.muteMode) {
          this.closePicker();
          this.toggleNoteMute(y, x);
        } else {
          this.openStepPicker(y, x);
        }
      }
      return;
    }

    if (y === 7 && p.kind === 'scale' && x === SCALE_BUTTON_COL) {
      this.closePicker();
      return;
    }
    if (y === 7 && p.kind === 'quantize' && x === QUANTIZE_BUTTON_COL) {
      // Double-click on quantize button while picker is open = disable.
      this.handleQuantizeButton();
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
    } else if (p.kind === 'scale') {
      const name = SCALE_PICKER_ROWS[y]?.[x];
      if (!name) return;
      this.engine.scale = scales[name];
      console.log(`[scale] ${name}`);
    } else if (p.kind === 'quantize') {
      const v = QUANTIZE_PICKER[y * GRID_W + x];
      if (v === undefined) return;
      this.engine.quantize = v;
      console.log(`[quantize] ${v}`);
    }
    this.closePicker();
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

  private openQuantizePicker(): void {
    this.picker = { kind: 'quantize' };
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
    // noteMute is parallel to A.note only — no B-side mute mask.
    if (layer === 'A' && param === 'note') {
      const m = this.engine.channels[ch].noteMute;
      if (col < m.length) m.splice(col, 1);
    }
    this.commitStep(ch, param, next, layer);
  }

  private commitStep(ch: number, param: ParamName, vals: number[], layer: Layer): void {
    const final = vals.length === 0 ? [defaultAppend(param, layer)] : vals;
    const c = this.engine.channels[ch];
    if (layer === 'A') {
      c[param] = sequins(final);
      if (param === 'note') {
        // Realign noteMute to A.note's new length.
        const m = c.noteMute;
        while (m.length < final.length) m.push(false);
        if (m.length > final.length) m.length = final.length;
      }
    } else {
      const key = (param + 'B') as keyof ChannelState;
      (c as unknown as Record<string, Sequins<number>>)[key] = sequins(final);
    }
    console.log(`[ch${ch + 1} ${param}${layer === 'B' ? 'B' : ''}] s(${JSON.stringify(final)})`);
  }

  // ---- truncate ----------------------------------------------------------

  // Trim the selected param's sequence on `ch` so that pressing column `col`
  // determines the new length. Routes through commitStep() so noteMute and
  // empty-sequence protection are handled automatically. Truncates whichever
  // layer is currently being viewed.
  private truncateStep(ch: number, col: number): void {
    const param = this.selectedParam;
    const layer = this.paramLayer;
    const next = this.seqRef(ch, param, layer).values.slice();
    next.splice(col);
    this.commitStep(ch, param, next, layer);
  }

  // ---- mute --------------------------------------------------------------

  private toggleNoteMute(ch: number, col: number): void {
    if (this.paramLayer !== 'A') return;  // mute only applies to A layer
    const state = this.engine.channels[ch];
    const noteLen = state.note.length;
    if (col >= noteLen) return;   // nothing to mute at this column
    while (state.noteMute.length < noteLen) state.noteMute.push(false);
    state.noteMute[col] = !state.noteMute[col];
    console.log(`[ch${ch + 1} mute] note[${col}] = ${state.noteMute[col]}`);
    this.renderChannelRow(ch);
  }

  // ---- row 6 / row 7 -----------------------------------------------------

  private handleRow6(x: number): void {
    if (x < 6) {
      const ch1 = x + 1;
      if (this.engine.isRunning(x)) this.engine.stop(ch1);
      else this.engine.launch(ch1);
    }
    // 6..11 unused; 12..15 reserved for scenes
  }

  private handleRow7(x: number): void {
    if (x < PARAMS.length) {
      if (PARAMS[x] === this.selectedParam) {
        this.paramLayer = this.paramLayer === 'A' ? 'B' : 'A';
      } else {
        this.selectedParam = PARAMS[x];
        this.paramLayer = 'A';
      }
      this.picker = null;  // invalidate any open picker when layer/param changes
      this.renderAll();
      this.updateStatus();
    } else if (x === SCALE_BUTTON_COL) {
      this.openScalePicker();
    } else if (x === QUANTIZE_BUTTON_COL) {
      this.handleQuantizeButton();
    } else if (x === MUTE_BUTTON_COL) {
      this.muteMode = !this.muteMode;
      if (this.muteMode) this.truncateMode = false;
      this.renderAll();
      this.updateStatus();
    } else if (x === TRUNCATE_BUTTON_COL) {
      this.truncateMode = !this.truncateMode;
      if (this.truncateMode) this.muteMode = false;
      this.renderAll();
      this.updateStatus();
    } else if (x === ENV_MODE_BUTTON_COL) {
      this.engine.envMode = ((this.engine.envMode + 1) % 3) as 0 | 1 | 2;
      this.renderRow7();
      this.updateStatus();
    } else if (x === GEODE_MODE_BUTTON_COL) {
      this.engine.geodeMode = ((this.engine.geodeMode + 1) % 4) as 0 | 1 | 2 | 3;
      this.renderRow7();
      this.updateStatus();
    } else if (x === KB_MODE_BUTTON_COL) {
      this.enterKbMode();
    }
  }

  // Single-click toggles the picker; double-click within DOUBLE_CLICK_MS
  // disables quantize (sets to 0). Works whether the picker is currently
  // open or closed, so a fast tap-tap always disables.
  private handleQuantizeButton(): void {
    const now = Date.now();
    const isDouble = (now - this.quantizeClickTime) < DOUBLE_CLICK_MS;
    this.quantizeClickTime = isDouble ? 0 : now;

    if (isDouble) {
      this.engine.quantize = 0;
      console.log('[quantize] 0 (double-click disabled)');
      if (this.picker?.kind === 'quantize') this.closePicker();
      else this.renderRow7();
      return;
    }

    if (this.picker?.kind === 'quantize') {
      this.closePicker();
    } else {
      if (this.picker) this.closePicker();
      this.openQuantizePicker();
    }
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
      case 'step':     this.renderStepPicker(this.picker); break;
      case 'scale':    this.renderScalePicker(); break;
      case 'quantize': this.renderQuantizePicker(); break;
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
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const name = SCALE_PICKER_ROWS[y]?.[x];
        let b: number;
        if (!name)                       b = 0;
        else if (scales[name] === active) b = 15;
        else                              b = 5;
        this.grid.setLed(x, y, b);
      }
    }
  }

  private renderQuantizePicker(): void {
    const cur = this.engine.quantize;
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const v = QUANTIZE_PICKER[y * GRID_W + x];
        this.grid.setLed(x, y, v === cur ? 15 : 5);
      }
    }
  }

  private renderChannelRow(ch: number): void {
    const param = this.selectedParam;
    const layer = this.paramLayer;
    const seq = this.seqRef(ch, param, layer);
    const vals = seq.values;
    const mute = (param === 'note' && layer === 'A')
      ? this.engine.channels[ch].noteMute
      : null;

    for (let i = 0; i < GRID_W; i++) {
      if (i < vals.length) {
        const isMuted = mute?.[i] === true;
        const b = isMuted
          ? (this.muteMode ? 6 : 2)
          : valueBrightness(param, vals[i]);
        this.grid.setLed(i, ch, b);
        this.grid.setStrobe(i, ch, isMuted && this.muteMode);
      } else if (i === vals.length && vals.length < GRID_W) {
        this.grid.setLed(i, ch, 1);
        this.grid.setStrobe(i, ch, false);
      } else {
        this.grid.setLed(i, ch, 0);
        this.grid.setStrobe(i, ch, false);
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

  private renderRow6(): void {
    for (let x = 0; x < 6; x++) {
      this.grid.setLed(x, 6, this.engine.isRunning(x) ? 15 : 4);
    }
    for (let x = 6; x < 12; x++) this.grid.setLed(x, 6, 0);
    for (let x = 12; x < GRID_W; x++) this.grid.setLed(x, 6, 1); // scene stub
  }

  private renderRow7(): void {
    for (let x = 0; x < PARAMS.length; x++) {
      const isSelected = PARAMS[x] === this.selectedParam;
      this.grid.setLed(x, 7, isSelected ? 15 : 5);
      this.grid.setStrobe(x, 7, isSelected && this.paramLayer === 'B');
    }
    const scaleOpen = this.picker?.kind === 'scale';
    this.grid.setLed(SCALE_BUTTON_COL, 7, scaleOpen ? 15 : 8);
    const qOpen = this.picker?.kind === 'quantize';
    const qBright = qOpen ? 15 : (this.engine.quantize > 0 ? 8 : 2);
    this.grid.setLed(QUANTIZE_BUTTON_COL, 7, qBright);
    // Mute mode button — bright + strobing while active so it visually echoes
    // the muted cells it targets.
    this.grid.setLed(MUTE_BUTTON_COL, 7, this.muteMode ? 15 : 4);
    this.grid.setStrobe(MUTE_BUTTON_COL, 7, this.muteMode);
    this.grid.setLed(TRUNCATE_BUTTON_COL, 7, this.truncateMode ? 15 : 4);
    this.grid.setStrobe(TRUNCATE_BUTTON_COL, 7, this.truncateMode);
    this.grid.setLed(ENV_MODE_BUTTON_COL, 7, ENV_MODE_BRIGHTNESS[this.engine.envMode]);
    this.grid.setLed(GEODE_MODE_BUTTON_COL, 7, GEODE_MODE_BRIGHTNESS[this.engine.geodeMode]);
    for (let x = 12; x < GRID_W; x++) this.grid.setLed(x, 7, 0);
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
      if (x === KB_MODE_BUTTON_COL)  { this.exitKbMode(); return; }
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
        console.log(`[kb env] ${v.toFixed(3)} len=${this.kbEnvBuffer.length}`);
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
      this.grid.setStrobe(x, 7, isSelected && this.kbBLayer);
    }
    for (let x = 6; x < 12; x++) this.grid.setLed(x, 7, 0);
    this.grid.setLed(KB_MODE_BUTTON_COL,   7, 15);
    this.grid.setStrobe(KB_MODE_BUTTON_COL, 7, true);
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
    if (this.muteMode) {
      this.statusEl.textContent =
        `MUTE mode — tap a step to toggle silence · tap mute button (row 7 col 8) to exit`;
      return;
    }
    if (this.truncateMode) {
      this.statusEl.textContent =
        `TRUNCATE mode — tap a step to trim ${this.selectedParam} ${this.paramLayer} sequence to that length · tap truncate button (row 7 col 9) to exit`;
      return;
    }
    const p = this.picker;
    if (p?.kind === 'step') {
      const v = this.seqRef(p.ch, this.selectedParam, p.layer).values[p.col];
      const layerTag = p.layer === 'B' ? `${this.selectedParam}B` : this.selectedParam;
      this.statusEl.textContent =
        `editing ch${p.ch + 1} step ${p.col} ${layerTag}=${v} — pick on rows 0-1, tap step again to remove`;
    } else if (p?.kind === 'scale') {
      this.statusEl.textContent =
        `pick a scale on rows 0-1 — tap scale button again to cancel`;
    } else if (p?.kind === 'quantize') {
      this.statusEl.textContent =
        `pick quantize on rows 0-1 (1..32) — double-click button to disable, tap again to cancel`;
    } else {
      const envMode = ENV_MODE_NAMES[this.engine.envMode];
      const geodeMode = GEODE_MODE_NAMES[this.engine.geodeMode];
      const layerHint = this.paramLayer === 'B'
        ? `B layer (press ${this.selectedParam} button again for A)`
        : `A layer (press ${this.selectedParam} button again for B · up to 16 steps)`;
      this.statusEl.textContent = `editing ${this.selectedParam} · ${layerHint} · env: ${envMode} · geode: ${geodeMode}`;
    }
  }
}
