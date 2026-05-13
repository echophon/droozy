// Monome-style 16x8 button grid. The hardware uses 4-bit brightness
// (0..15) per LED and reports key down/up; this DOM component mirrors both.
//
// Coordinate convention: x = column (0..15), y = row (0..7), top-left origin
// — same as serialosc, so a future hardware bridge is a straight 1:1 mapping.

export const GRID_W = 16;
export const GRID_H = 8;

type PressFn = (x: number, y: number) => void;

export class Grid {
  private root: HTMLElement;
  private cells: HTMLButtonElement[];   // index = y * GRID_W + x
  private brightness: Uint8Array;
  private pressListeners = new Set<PressFn>();
  private releaseListeners = new Set<PressFn>();

  constructor(root: HTMLElement) {
    this.root = root;
    this.cells = new Array(GRID_W * GRID_H);
    this.brightness = new Uint8Array(GRID_W * GRID_H);

    const frag = document.createDocumentFragment();
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const btn = document.createElement('button');
        btn.className = 'cell';
        btn.dataset.x = String(x);
        btn.dataset.y = String(y);
        btn.dataset.row = String(y);
        btn.style.setProperty('--led', '0');
        btn.setAttribute('aria-label', `cell ${x},${y}`);
        this.cells[y * GRID_W + x] = btn;
        frag.appendChild(btn);
      }
    }
    this.root.appendChild(frag);

    // Single delegated handler for all 128 cells. Pointer events handle both
    // touch and mouse uniformly; setPointerCapture isn't needed because we
    // don't track drags, only press/release on the originating cell.
    this.root.addEventListener('pointerdown', e => this.handlePointer(e, this.pressListeners));
    this.root.addEventListener('pointerup',   e => this.handlePointer(e, this.releaseListeners));
    this.root.addEventListener('pointercancel', e => this.handlePointer(e, this.releaseListeners));
    // Prevent context menu / text selection on long-press.
    this.root.addEventListener('contextmenu', e => e.preventDefault());
  }

  private handlePointer(e: PointerEvent, listeners: Set<PressFn>): void {
    const target = e.target as HTMLElement | null;
    if (!target || !target.classList.contains('cell')) return;
    e.preventDefault();
    const x = Number(target.dataset.x);
    const y = Number(target.dataset.y);
    for (const fn of listeners) fn(x, y);
  }

  setLed(x: number, y: number, brightness: number): void {
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
    const lvl = Math.max(0, Math.min(15, brightness | 0));
    const idx = y * GRID_W + x;
    if (this.brightness[idx] === lvl) return;
    this.brightness[idx] = lvl;
    this.cells[idx].style.setProperty('--led', String(lvl));
  }

  /** Set a CSS-driven strobe animation on a single cell.
   *  'slow' (~0.6 Hz) = persistent state (B layer, prob-hit toggle).
   *  'fast' (~1.4 Hz) = active mode (truncate, prob, randomize, mutate, KB).
   *  'off'            = no animation. */
  setStrobe(x: number, y: number, speed: 'off' | 'slow' | 'fast'): void {
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
    const cell = this.cells[y * GRID_W + x];
    cell.classList.toggle('strobe-slow', speed === 'slow');
    cell.classList.toggle('strobe-fast', speed === 'fast');
  }

  setRow(y: number, levels: ArrayLike<number>): void {
    const n = Math.min(levels.length, GRID_W);
    for (let x = 0; x < n; x++) this.setLed(x, y, levels[x]);
  }

  clear(): void {
    for (let i = 0; i < this.cells.length; i++) {
      if (this.brightness[i] !== 0) {
        this.brightness[i] = 0;
        this.cells[i].style.setProperty('--led', '0');
      }
      // Strobe classes outlive brightness — strip both on clear so a re-render
      // can decide whether to re-add them for any cell.
      this.cells[i].classList.remove('strobe-slow', 'strobe-fast');
    }
  }

  onPress(fn: PressFn): () => void {
    this.pressListeners.add(fn);
    return () => this.pressListeners.delete(fn);
  }

  onRelease(fn: PressFn): () => void {
    this.releaseListeners.add(fn);
    return () => this.releaseListeners.delete(fn);
  }
}
