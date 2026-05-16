# potionshop

A browser-based FM burst sequencer. Six channels each fire rhythmic bursts of repeated FM tones. Every parameter follows its own looping sequence, so patterns drift and phase independently.

---

## parameters · row 7, cols 0–5

| param | description |
|-------|-------------|
| **div** | burst divisor 1–16 · smaller = faster |
| **reps** | repetitions per burst · 1–8 or ∞ |
| **note** | scale degree · default scale is major |
| **level** | amplitude 0–1 · also acts as geode RUN CV |
| **harm** | FM ratio 2–18 · integers = harmonic · non-integers = metallic |
| **env** | envelope shape · 0 = snappy · 1 = slower decay |

Tap a param button again to toggle **A ↔ B layer** (B is an additive offset over A · slow-strobes when active).

---

## step editing · rows 0–5

- Left cols 0–7 = A layer · right cols 8–13 = B layer
- Tap a step → value picker appears on rows 0–1
- Tap past the last step to extend the sequence
- Tap a step again inside the picker to delete it

---

## actions · row 7, cols 12–15

| button | description |
|--------|-------------|
| **CLR · 12** | arm → tap channel → clear selected param's A+B |
| **LOCK · 13** | arm → tap channels to toggle locked mode — keeps all param lengths equal · on by default |
| **RND · 14** | arm → tap channel → randomize all A-layer params |
| **MUT · 15** | arm → tap channel → nudge A-layer values ±25% |

---

## launch & modes · row 6

| col | description |
|-----|-------------|
| **0–5** | tap to launch or stop each channel · channels snap to the launch grid (default: next quarter note) |
| **RST · 11** | per-channel sequin reset · tap to enter · each row sets that channel's interval · cols 0–8 = bars (0 = off) |
| **KB · 12** | keyboard mode · tap values directly to build sequences gesture by gesture |
| **PROB · 13** | burst probability per channel · cols 0–14 = 0–100% · col 15 = per-burst vs per-hit |
| **QNT · 14** | opens scale + quantize picker · row 0: scale · row 1: 1–16 events per whole note |
| **SND · 15** | sound mode — geode + volume depth + pitch/harmonicity envelopes |

---

## sound mode (SND)

| cols | description |
|------|-------------|
| **0–2** | geode mode: **sustain** · transient · cycle — always one active |
| **4–7** | volume depth: 0=subtle → 3=full · scales geode oscillation range |
| **8–11** | pitch envelope depth 1–4 · tap active to turn off · sweeps carrier from a higher pitch down |
| **12–15** | harmonicity envelope depth 1–4 · tap active to turn off · sweeps FM ratio from more inharmonic |

**Geode modes** — per-hit amplitude patterns driven by the `level` parameter as a bipolar RUN CV (0.5 = neutral):
- **sustain** — decaying triangle fold across the burst
- **transient** — sawtooth accent cycle; positive level = falling, negative = rising
- **cycle** — sinusoidal tremolo; positive level = slow periods, negative = sub-beat shimmer

---

## keyboard mode

- **Page 1** · rows 0–1 note · rows 2–3 div · rows 4–5 reps
- **Page 2** · rows 0–1 level · rows 2–3 harm · rows 4–5 env
- Row 6: scale selector (8 options)
- Row 7: channel select · tap same channel to toggle A/B layer
- Col 12 commit+exit · col 13 page toggle · col 14 clear buffers

---

## scales + quantize · row 7 col 6 (or QNT)

- **Row 0**: chromatic · major · minor · pentatonic · dorian · akebono · hijaz · kurd · bayati · rast · zen · wuSheng
- **Row 1**: quantize 1–16 events per whole note

---

## locked mode

All channels start locked — adding or removing a step on any parameter extends or trims all others to match. Arm LOCK (row 7 col 13) and tap a channel to toggle. Randomize also respects locked state.

---

## REPL commands

```js
launch(ch, div?, reps?, note?, level?, harm?, env?)  // start or replace channel ch (1..6)
stop(ch)   stopAll()                                 // silence one or all
s([1,2,3])                                           // make a sequins (cycles forever)
refresh()                                            // redraw grid after direct state writes
```

```js
// direct state
engine.channels[0].note = s([0,4,7])
setScale(scales.akebono)                             // or engine.scale = scales.akebono; refresh()
engine.quantize = 16                                 // per-fire snap (0=off · events per whole note)
engine.launchGrid = 4                                // launch alignment grid (0=off)
```

**Scales**: `major` · `minor` · `pentatonic` · `dorian` · `chromatic` · `akebono` · `hijaz` · `kurd` · `bayati` · `rast` · `zen` · `wuSheng`

**Examples**:
```js
launch(1, 8, 4, 2)
setScale(scales.major); launch(1, s([4,3]), -1, s([0,4,7]), 0.7)
launch(1, 8, s([4,3]), s([0,4,7]), s([1,0.5]), s([2,2,7]))
```
