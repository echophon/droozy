import * as Tone from 'tone';
import { BurstEngine } from './burst';
import { FMVoice, defaultVoiceParams } from './voice';
import { Grid } from './grid';
import { GridController } from './grid-controller';
import { Repl } from './repl';
import { sequins, asSeq, sum } from './sequins';
import { scales } from './scales';

const startBtn = document.getElementById('start') as HTMLButtonElement;
const bpmInput = document.getElementById('bpm') as HTMLInputElement;
const status = document.getElementById('status')!;

let booted = false;

startBtn.addEventListener('click', async () => {
  if (booted) return;
  booted = true;
  startBtn.disabled = true;
  status.textContent = 'starting…';

  await Tone.start();
  const transport = Tone.getTransport();
  transport.bpm.value = Number(bpmInput.value) || 120;
  transport.start();

  bpmInput.addEventListener('input', () => {
    const v = Number(bpmInput.value);
    if (Number.isFinite(v) && v >= 30 && v <= 300) transport.bpm.value = v;
  });

  // master output with a touch of headroom; bursts can pile up fast
  const limiter = new Tone.Limiter(-3).toDestination();
  const out = new Tone.Gain(0.6).connect(limiter);

  const voices = Array.from(
    { length: 6 },
    () => new FMVoice(out, { ...defaultVoiceParams }),
  );
  const engine = new BurstEngine(voices);
  const grid = new Grid(document.getElementById('grid')!);
  const controller = new GridController(engine, grid);

  // Console-as-REPL — mirrors the Lua original's launch()/stop() workflow.
  // Type `launch(1, 8, 4, s([0,4,7]))` in DevTools to drive things directly.
  const w = window as unknown as Record<string, unknown>;
  w.engine = engine;
  w.launch = (
    ch: number,
    div?: number | ReturnType<typeof sequins<number>>,
    reps?: number | ReturnType<typeof sequins<number>>,
    note?: number | ReturnType<typeof sequins<number>>,
    level?: number | ReturnType<typeof sequins<number>>,
    harm?: number | ReturnType<typeof sequins<number>>,
    env?: number | ReturnType<typeof sequins<number>>,
  ) => {
    engine.launch(ch, { div, reps, note, level, harm, env });
  };
  w.setScale = (scale: readonly number[]) => {
    engine.scale = scale;
    controller.refresh();
  };
  w.stop = (ch: number) => engine.stop(ch);
  w.stopAll = () => engine.stopAll();
  w.s = sequins;
  w.sum = sum;
  w.asSeq = asSeq;
  w.scales = scales;
  w.Tone = Tone;
  // Call refresh() after direct state writes that don't go through launch()
  // (e.g. `engine.quantize = 16` or `engine.scale = scales.minor`).
  w.refresh = () => controller.refresh();
  // geodeMode(n) — 0=off, 1=transient, 2=sustain, 3=cycle. Matches the col-11
  // grid button. Call refresh() after to update the LED.
  w.geodeMode = (mode: 0 | 1 | 2 | 3) => {
    engine.geodeMode = mode;
    controller.refresh();
  };

  const repl = new Repl(
    document.getElementById('repl-editor')!,
    document.getElementById('repl-output')!,
    'launch(1, 8, 4, s([0,4,7]))',
  );
  document.getElementById('repl-run')!
    .addEventListener('click', () => repl.run());
  document.getElementById('repl-clear')!
    .addEventListener('click', () => repl.clearOutput());

  document.getElementById('audio-overlay')!.classList.add('hidden');
  repl.focus();

  status.textContent = 'running — type into the repl below, cmd-enter (or click run) to evaluate';
});
