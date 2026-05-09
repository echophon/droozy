import * as Tone from 'tone';
import { snapBeat } from './quantize';

// Beat-counted time atop Tone.Transport. Tone.Transport.seconds is the
// transport position in seconds; multiplying by bpm/60 yields beats since
// transport start. This is the analogue of Norns' clock.get_beats().

export function getBeats(): number {
  return Tone.getTransport().seconds * (Tone.getTransport().bpm.value / 60);
}

export function getTempo(): number {
  return Tone.getTransport().bpm.value;
}

export function beatsToSeconds(beats: number): number {
  return (beats * 60) / Tone.getTransport().bpm.value;
}

export function sleepSecs(s: number): Promise<void> {
  if (s <= 0) return Promise.resolve();
  return new Promise(resolve => setTimeout(resolve, s * 1000));
}

// Direct port of wait_beat: snap forward to the next quantize grid point,
// then sleep until that beat arrives. The math is in ./quantize so it can
// be unit-tested without an audio context.
export async function waitUntilBeat(target: number, quantize: number): Promise<void> {
  const fire = snapBeat(target, quantize);
  const wait = beatsToSeconds(fire - getBeats());
  if (wait > 0) await sleepSecs(wait);
}
