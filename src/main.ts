import * as Tone from 'tone';
import { BurstEngine } from './burst';
import { FMVoice, defaultVoiceParams } from './voice';
import { Grid } from './grid';
import { GridController } from './grid-controller';
import { Repl } from './repl';
import { sequins, asSeq, sum, Sequins } from './sequins';
import { scales } from './scales';
import { MidiOutput } from './midi-output';

const startBtn = document.getElementById('start') as HTMLButtonElement;
const bpmInput = document.getElementById('bpm') as HTMLInputElement;
const muteAudio = document.getElementById('mute-audio') as HTMLInputElement;
const playStopBtn = document.getElementById('play-stop') as HTMLButtonElement;
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

  // master output: gain → multiband compressor → limiter → destination
  const limiter = new Tone.Limiter(-3).toDestination();

  // multiband compressor: low (<200 Hz), mid (200–2000 Hz), high (>2000 Hz)
  const mbcSum = new Tone.Gain(0.7).connect(limiter);

  const lowpass1  = new Tone.Filter(200,  'lowpass',  -24);
  const highpass1 = new Tone.Filter(200,  'highpass', -24);
  const lowpass2  = new Tone.Filter(2000, 'lowpass',  -24);
  const highpass2 = new Tone.Filter(2000, 'highpass', -24);

  const compLow  = new Tone.Compressor({ threshold: -18, ratio: 4, attack: 0.003, release: 0.1 });
  const compMid  = new Tone.Compressor({ threshold: -20, ratio: 4, attack: 0.005, release: 0.15 });
  const compHigh = new Tone.Compressor({ threshold: -24, ratio: 4, attack: 0.001, release: 0.08 });

  // band routing: input → filter → compressor → sum
  const mbcIn = new Tone.Gain(1);
  mbcIn.connect(lowpass1);
  mbcIn.connect(highpass1);
  highpass1.connect(lowpass2);
  highpass1.connect(highpass2);

  lowpass1.connect(compLow);
  lowpass2.connect(compMid);
  highpass2.connect(compHigh);

  compLow.connect(mbcSum);
  compMid.connect(mbcSum);
  compHigh.connect(mbcSum);

  const out = new Tone.Gain(0.5).connect(mbcIn);

  muteAudio.addEventListener('change', () => {
    out.gain.value = muteAudio.checked ? 0 : 0.6;
  });

  const voices = Array.from(
    { length: 6 },
    () => new FMVoice(out, { ...defaultVoiceParams }),
  );
  const engine = new BurstEngine(voices);
  const grid = new Grid(document.getElementById('grid')!);
  const controller = new GridController(engine, grid);

  const midiSelect = document.getElementById('midi-out') as HTMLSelectElement;
  const midi = new MidiOutput();
  midi.init().then(outputs => {
    midiSelect.disabled = false;
    for (const o of outputs) {
      const opt = document.createElement('option');
      opt.value = o.id;
      opt.textContent = o.name;
      midiSelect.appendChild(opt);
    }
    engine.on(ev => midi.handleEvent(ev));
  }).catch(() => {
    // MIDI access denied or unavailable — audio continues unaffected
  });
  midiSelect.addEventListener('change', () => {
    midi.selectOutput(midiSelect.value);
  });

  // Play / stop — resets all sequins to position 0 and relaunches running
  // channels. Sends MIDI Start/Stop and drives a 24-PPQN clock stream.
  // Tone.js Transport default PPQ = 192, so "8i" = 192/24 = 1 MIDI clock pulse.
  let transportPlaying = false;
  let lastRunning = new Array(6).fill(false) as boolean[];
  let clockEventId = -1;

  playStopBtn.disabled = false;
  playStopBtn.addEventListener('click', () => {
    if (transportPlaying) {
      lastRunning = engine.runningChannels();
      engine.stopAll();
      Tone.getTransport().clear(clockEventId);
      midi.sendStop();
      transportPlaying = false;
      playStopBtn.textContent = '▸ play';
    } else {
      // Snapshot which channels are running before reset (covers first play too)
      const toRestart = engine.runningChannels().map((r, i) => r || lastRunning[i]);
      engine.resetSequins();
      for (let i = 0; i < 6; i++) {
        if (toRestart[i]) engine.launch(i + 1);
      }
      midi.sendStart();
      clockEventId = Tone.getTransport().scheduleRepeat(() => midi.sendClock(), '8i');
      transportPlaying = true;
      playStopBtn.textContent = '■ stop';
    }
  });

  // Console-as-REPL — mirrors the Lua original's launch()/stop() workflow.
  // Type `launch(1, 8, 4, s([0,4,7]))` in DevTools to drive things directly.
  const w = window as unknown as Record<string, unknown>;
  w.engine = engine;
  // Scale env from the 0..31 UI range to the 0..1 internal range.
  const scaleEnv = (v: number | Sequins<number>): number | Sequins<number> =>
    typeof v === 'number'
      ? v / 31
      : sequins(v.values.map(n => n / 31));

  w.launch = (
    ch: number,
    div?: number | ReturnType<typeof sequins<number>>,
    reps?: number | ReturnType<typeof sequins<number>>,
    note?: number | ReturnType<typeof sequins<number>>,
    level?: number | ReturnType<typeof sequins<number>>,
    harm?: number | ReturnType<typeof sequins<number>>,
    env?: number | ReturnType<typeof sequins<number>>,
  ) => {
    engine.launch(ch, { div, reps, note, level, harm, env: env !== undefined ? scaleEnv(env) : undefined });
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
  // (e.g. `engine.quantize = 8` or `engine.scale = scales.minor`).
  w.refresh = () => controller.refresh();
  // geodeMode(n, ch?) — set geode mode (0=off 1=transient 2=sustain 3=cycle).
  // Omit ch to set all channels; ch is 1-indexed.
  w.geodeMode = (mode: 0 | 1 | 2 | 3, ch?: number) => {
    if (ch !== undefined) {
      if (ch >= 1 && ch <= 6) engine.channels[ch - 1].geodeMode = mode;
    } else {
      engine.channels.forEach(c => { c.geodeMode = mode; });
    }
    controller.refresh();
  };
  // setProb(ch, 0..1) — burst fire probability for channel ch (1-indexed).
  w.setProb = (ch: number, prob: number) => {
    if (ch >= 1 && ch <= 6) {
      engine.channels[ch - 1].burstProb = Math.max(0, Math.min(1, prob));
      controller.refresh();
    }
  };
  // randomize(ch) — replace ch's A-layer sequins with new musical values.
  w.randomize = (ch: number) => { engine.randomize(ch); controller.refresh(); };
  // mutate(ch, amount=0.25) — perturb ch's A-layer values by ±amount.
  w.mutate = (ch: number, amount = 0.25) => { engine.mutate(ch, amount); controller.refresh(); };

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
