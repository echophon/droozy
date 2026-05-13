import type { BurstEvent } from './burst';

function freqToMidi(freq: number): number {
  return Math.max(0, Math.min(127, Math.round(69 + 12 * Math.log2(freq / 440))));
}

export class MidiOutput {
  private access: MIDIAccess | null = null;
  private outputId: string | null = null;
  private pendingNoteOff = new Map<string, ReturnType<typeof setTimeout>>();
  enabled = false;

  async init(): Promise<{ id: string; name: string }[]> {
    this.access = await navigator.requestMIDIAccess({ sysex: false });
    return this.listOutputs();
  }

  listOutputs(): { id: string; name: string }[] {
    if (!this.access) return [];
    return Array.from(this.access.outputs.values()).map(o => ({
      id: o.id,
      name: o.name ?? o.id,
    }));
  }

  selectOutput(id: string): void {
    this.outputId = id;
    this.enabled = id !== '';
  }

  handleEvent(ev: BurstEvent): void {
    if (!this.enabled || ev.type === 'launch') return;

    if (ev.type === 'stop') {
      // All notes off on this MIDI channel
      this.send([0xB0 | ev.ch, 123, 0]);
      return;
    }

    // ev.type === 'fire'
    const note = freqToMidi(ev.freq);
    const velocity = Math.max(1, Math.min(127, Math.round(ev.level * 127)));
    const cc1 = Math.max(0, Math.min(127, Math.round(((ev.harm - 2) / 2) * 127)));
    const cc2 = Math.max(0, Math.min(127, Math.round(ev.env * 127)));
    const ch = ev.ch;

    // Cancel any pending note-off for this pitch on this channel
    const key = `${ch}-${note}`;
    const pending = this.pendingNoteOff.get(key);
    if (pending !== undefined) {
      clearTimeout(pending);
      this.send([0x80 | ch, note, 0]);
    }

    this.send([0xB0 | ch, 1, cc1]);   // CC1 mod wheel
    this.send([0xB0 | ch, 2, cc2]);   // CC2 breath
    this.send([0x90 | ch, note, velocity]);

    const noteOffMs = 50 + ev.env * 450;
    this.pendingNoteOff.set(key, setTimeout(() => {
      this.pendingNoteOff.delete(key);
      this.send([0x80 | ch, note, 0]);
    }, noteOffMs));
  }

  sendStart(): void { this.send([0xFA]); }
  sendStop(): void  { this.send([0xFC]); }
  sendClock(): void { this.send([0xF8]); }

  private send(data: number[]): void {
    if (!this.access || !this.outputId) return;
    this.access.outputs.get(this.outputId)?.send(data);
  }
}
