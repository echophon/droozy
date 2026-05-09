import { BurstEngine, ChannelState, NUM_CHANNELS } from './burst';
import { Grid, GRID_W } from './grid';
import { Sequins, sequins } from './sequins';
import { scales, ScaleName } from './scales';

// Layout reference:
//   rows 0..5 = per-channel step view of `selectedParam` (left-packed sequins)
//   row 6     = 0..5 launch | 6..11 unused | 12..15 scenes (stub)
//   row 7     = 0..5 param (div/reps/note/level/harm/env)
//             | 6 scale | 7 quantize | 8 MUTE mode | 9 TRUNCATE mode | 10..15 unused
//
// PICKERS (rows 0..1, momentary)
//   step picker   — tap a step on rows 0..5 (with mute mode OFF)
//   scale picker  — tap row 7 col 6
//   quantize picker — tap row 7 col 7 (double-click disables instead of opening)
//
// MUTE MODIFIER (row 6 col 6)
//   Tap to latch into mute mode. While latched, taps on channel rows toggle
//   the noteMute flag at that column. Tap again to exit. The modifier acts on
//   the per-channel `noteMute` array (parallel to the note sequins) so that
//   individual notes can be silenced without losing their values.
//
// LAYER TOGGLE (row 7 cols 0..5, second press)
//   Pressing the currently-selected param button again toggles into the B
//   layer view of that param. Each channel holds a parallel B sequins per
//   param (default sequins([0])); the engine sums A.next()+B.next() at fire
//   time. Switching params resets to A. Entering mute mode forces A view
//   (mute is keyed off A's note positions).

type ParamName = 'div' | 'reps' | 'note' | 'level' | 'harm' | 'env';
const PARAMS: ParamName[] = ['div', 'reps', 'note', 'level', 'harm', 'env'];

const SCALE_BUTTON_COL = 6;
const QUANTIZE_BUTTON_COL = 7;
const MUTE_BUTTON_COL = 8;
const TRUNCATE_BUTTON_COL = 9;

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
  private selectedLayer: Layer = 'A';
  private picker: Picker | null = null;
  private muteMode = false;
  private truncateMode = false;
  private quantizeClickTime = 0;
  private statusEl: HTMLElement | null;

  constructor(engine: BurstEngine, grid: Grid) {
    this.engine = engine;
    this.grid = grid;
    this.statusEl = document.getElementById('status');

    grid.onPress((x, y) => this.handlePress(x, y));

    engine.on(ev => {
      switch (ev.type) {
        case 'fire':
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
      if (y === p.ch && x === p.col) {
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
    const layer = this.selectedLayer;
    const cur = this.seqRef(ch, param, layer).values;
    if (col === cur.length) {
      const next = cur.slice();
      next.push(defaultAppend(param, layer));
      this.commitStep(ch, param, next, layer);
      this.picker = { kind: 'step', ch, col, layer };
    } else if (col < cur.length) {
      this.picker = { kind: 'step', ch, col, layer };
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
    const layer = this.selectedLayer;
    const next = this.seqRef(ch, param, layer).values.slice();
    next.splice(col);
    this.commitStep(ch, param, next, layer);
  }

  // ---- mute --------------------------------------------------------------

  private toggleNoteMute(ch: number, col: number): void {
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
      const p = PARAMS[x];
      if (p === this.selectedParam) {
        // second press of the already-selected param toggles A↔B view
        this.selectedLayer = this.selectedLayer === 'A' ? 'B' : 'A';
      } else {
        this.selectedParam = p;
        this.selectedLayer = 'A';
      }
      this.renderAll();
      this.updateStatus();
    } else if (x === SCALE_BUTTON_COL) {
      this.openScalePicker();
    } else if (x === QUANTIZE_BUTTON_COL) {
      this.handleQuantizeButton();
    } else if (x === MUTE_BUTTON_COL) {
      this.muteMode = !this.muteMode;
      if (this.muteMode) {
        this.truncateMode = false;
        // mute is keyed off A's note positions — flip back to A so the view
        // matches what the modifier actually targets.
        this.selectedLayer = 'A';
      }
      // renderAll so muted cells in any visible channel row pick up the
      // strobe state immediately.
      this.renderAll();
      this.updateStatus();
    } else if (x === TRUNCATE_BUTTON_COL) {
      this.truncateMode = !this.truncateMode;
      if (this.truncateMode) this.muteMode = false;
      this.renderAll();
      this.updateStatus();
    }
    // col 5 reserved; 10-15 unused
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
    const layer = this.selectedLayer;
    const seq = this.seqRef(ch, param, layer);
    const vals = seq.values;
    // Note-row mute indication: only applies when viewing A's note param —
    // mute is keyed off A's positions and B has no parallel mask.
    const mute = (param === 'note' && layer === 'A')
      ? this.engine.channels[ch].noteMute
      : null;

    for (let x = 0; x < GRID_W; x++) {
      if (x < vals.length) {
        const isMuted = mute?.[x] === true;
        // While in mute mode, muted cells get a higher base brightness so
        // the strobe animation has something visible to pulse against.
        const b = isMuted
          ? (this.muteMode ? 6 : 2)
          : valueBrightness(param, vals[x]);
        this.grid.setLed(x, ch, b);
        this.grid.setStrobe(x, ch, isMuted && this.muteMode);
      } else if (x === vals.length) {
        this.grid.setLed(x, ch, 1);
        this.grid.setStrobe(x, ch, false);
      } else {
        this.grid.setLed(x, ch, 0);
        this.grid.setStrobe(x, ch, false);
      }
    }

    if (this.engine.isRunning(ch) && vals.length > 0) {
      const playhead = (seq.index - 1 + vals.length) % vals.length;
      this.grid.setLed(playhead, ch, 15);
    }

    if (this.picker?.kind === 'step' && this.picker.ch === ch) {
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
      // Strobe the active param button while viewing its B layer — same
      // visual idiom as mute/truncate.
      this.grid.setStrobe(x, 7, isSelected && this.selectedLayer === 'B');
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
    for (let x = 10; x < GRID_W; x++) this.grid.setLed(x, 7, 0);
  }

  private updateStatus(): void {
    if (!this.statusEl) return;
    if (this.muteMode) {
      this.statusEl.textContent =
        `MUTE mode — tap a step to toggle silence · tap mute button (row 7 col 8) to exit`;
      return;
    }
    if (this.truncateMode) {
      this.statusEl.textContent =
        `TRUNCATE mode — tap a step to trim ${this.selectedParam} sequence to that length · tap truncate button (row 7 col 9) to exit`;
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
    } else if (this.selectedLayer === 'B') {
      this.statusEl.textContent =
        `editing ${this.selectedParam} (layer B — added to A) — tap param button again to return to A`;
    } else {
      this.statusEl.textContent = `editing ${this.selectedParam} — tap a step to change`;
    }
  }
}
