// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GridController } from '../grid-controller';
import { sequins } from '../sequins';
import { scales } from '../scales';

// Minimal Grid mock — captures onPress callbacks and exposes press() to simulate them
class MockGrid {
  private pressListeners: ((x: number, y: number) => void)[] = [];
  setLed    = vi.fn();
  setStrobe = vi.fn();
  setRow    = vi.fn();
  clear     = vi.fn();
  onPress(fn: (x: number, y: number) => void) {
    this.pressListeners.push(fn);
    return () => {};
  }
  onRelease(_fn: (x: number, y: number) => void) { return () => {}; }
  press(x: number, y: number) {
    for (const fn of this.pressListeners) fn(x, y);
  }
}

function makeChannel() {
  return {
    div:    sequins([4]),  reps:   sequins([1]),  note:  sequins([0]),
    level:  sequins([0.5]), harm:  sequins([2]),  env:   sequins([0]),
    divB:   sequins([0]),  repsB:  sequins([0]),  noteB: sequins([0]),
    levelB: sequins([0]),  harmB:  sequins([0]),  envB:  sequins([0]),
    locked: false, burstProb: 1, probHit: false,
    envMode: 0 as const, geodeMode: 0 as const, pitchEnv: 0 as const, harmEnv: 0 as const,
  };
}

function makeEngine() {
  return {
    channels:      Array.from({ length: 6 }, makeChannel),
    scale:         scales.chromatic,
    quantize:      16,
    resetInterval: 0,
    isRunning:        vi.fn().mockReturnValue(false),
    launch:           vi.fn(),
    stop:             vi.fn(),
    stopAll:          vi.fn(),
    on:               vi.fn(),
    runningChannels:  vi.fn().mockReturnValue(Array(6).fill(false)),
    randomize:        vi.fn(),
    mutate:           vi.fn(),
    resetSequins:     vi.fn(),
  };
}

// ---- helpers ----------------------------------------------------------------

function statusText(): string {
  return document.getElementById('status')?.textContent ?? '';
}

const isKbMode    = () => statusText().startsWith('KB MODE');
const isProbMode  = () => statusText().startsWith('PROB');
const isResetMode = () => statusText().startsWith('RESET');
const isSoundMode = () => statusText().startsWith('SOUND');

// ---- setup ------------------------------------------------------------------

let grid: MockGrid;

beforeEach(() => {
  document.body.innerHTML = '<p id="status"></p>';
  grid = new MockGrid();
  new GridController(makeEngine() as never, grid as never);
});

// ---- tests ------------------------------------------------------------------

describe('toggle button on/off positions', () => {
  it('KB mode (row 6, col 12): same button enters and exits', () => {
    expect(isKbMode()).toBe(false);
    grid.press(12, 6);
    expect(isKbMode()).toBe(true);
    grid.press(12, 6);  // same position must exit
    expect(isKbMode()).toBe(false);
  });

  it('PROB mode (row 6, col 13): same button toggles on and off', () => {
    expect(isProbMode()).toBe(false);
    grid.press(13, 6);
    expect(isProbMode()).toBe(true);
    grid.press(13, 6);
    expect(isProbMode()).toBe(false);
  });

  it('RST mode (row 6, col 11): same button toggles on and off', () => {
    expect(isResetMode()).toBe(false);
    grid.press(11, 6);
    expect(isResetMode()).toBe(true);
    grid.press(11, 6);
    expect(isResetMode()).toBe(false);
  });

  it('SND mode (row 6, col 15): same button toggles on and off', () => {
    expect(isSoundMode()).toBe(false);
    grid.press(15, 6);
    expect(isSoundMode()).toBe(true);
    grid.press(15, 6);
    expect(isSoundMode()).toBe(false);
  });
});
