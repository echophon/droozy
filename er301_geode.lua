-- er301_geode.lua
-- ER-301 via I2C in geode mode
-- play_voice(ch, pitch_volts, level_volts) is the trigger primitive:
--   ii.er301.cv(ch,       pitch_volts)   -- pitch CV on ch 1-6
--   ii.er301.cv(ch + 6,   level_volts)   -- level CV on ch 7-12
--   ii.er301.tr(ch, 1/0)                 -- gate pulse

s  = sequins
hs = { ch = {}, quantize = 0 }

scales = {
  chromatic  = {0,1,2,3,4,5,6,7,8,9,10,11},
  major      = {0,2,4,5,7,9,11},
  minor      = {0,2,3,5,7,8,10},
  pentatonic = {0,2,4,7,9},
  dorian     = {0,2,3,5,7,9,10},
}

for i = 1, 6 do
  hs.ch[i] = {
    div   = s{4},
    reps  = s{1},
    note  = s{0},
    level = s{5},
    scale = scales.chromatic,
  }
end

local coroutines = {}

local function play_voice(ch, volts, level)
  ii.er301.cv(ch,     volts)
  ii.er301.cv(ch + 6, level)
  ii.er301.tr(ch, 1)
  clock.sleep(0.005)
  ii.er301.tr(ch, 0)
end

local function note_to_volts(degree, scale)
  local len = #scale
  local oct = math.floor(degree / len)
  local idx = (degree % len) + 1
  return (oct * 12 + scale[idx]) / 12
end

local function interval_secs(div)
  return (60.0 / clock.tempo) * (4 / div)
end

-- wait until absolute beat `target`, snapping forward to the next quantize
-- grid point if quantize is active. Tempo is preserved because `target`
-- progresses at the natural rate; the snap only nudges the firing instant.
local function wait_beat(target)
  local fire = target
  if hs.quantize > 0 then
    local q = 4 / hs.quantize
    fire = math.ceil(target / q - 1e-9) * q
  end
  local wait_secs = (fire - clock.get_beats()) * (60 / clock.tempo)
  if wait_secs > 0 then clock.sleep(wait_secs) end
end

-- wrap plain values in sequins so burst can call them uniformly
local function as_seq(v)
  return type(v) == 'table' and v or s{v}
end

local function burst(ch, target)
  while true do
    local div_seq  = hs.ch[ch].div
    local reps_seq = hs.ch[ch].reps
    local note_seq = hs.ch[ch].note
    local div   = div_seq()
    local reps  = reps_seq()
    local volts = note_to_volts(note_seq(), hs.ch[ch].scale)
    local level = hs.ch[ch].level()
    local total = (reps == -1) and math.huge or reps
    local i = 1
    local restarted = false

    while i <= total do
      if hs.ch[ch].div ~= div_seq or hs.ch[ch].reps ~= reps_seq or hs.ch[ch].note ~= note_seq then
        restarted = true
        break
      end
      wait_beat(target)
      play_voice(ch, volts, level)
      target = target + 4 / div
      i = i + 1
    end

    if not restarted then return reps, div, target end
  end
end

function launch(ch, div, reps, note, level, scale)
  local cfg = hs.ch[ch]
  if div   then cfg.div   = as_seq(div)   end
  if reps  then cfg.reps  = as_seq(reps)  end
  if note  then cfg.note  = as_seq(note)  end
  if level then cfg.level = as_seq(level) end
  if scale then cfg.scale = scale         end
  if coroutines[ch] then clock.cancel(coroutines[ch]) end
  coroutines[ch] = clock.run(function()
    local target = clock.get_beats()
    while true do
      local r, d, t = burst(ch, target)
      target = t
      if r ~= -1 then
        if #hs.ch[ch].reps <= 1 then return end
        -- target is already advanced past the last hit; next burst's
        -- first event fires one division later, preserving the gap.
      end
    end
  end)
end

function stop(ch)
  if coroutines[ch] then
    clock.cancel(coroutines[ch])
    coroutines[ch] = nil
  end
end

function stop_all()
  for i = 1, 6 do stop(i) end
end

function init()
  input[1].mode("clock", 1)
  print("=== ER-301 Geode ===")
  print("launch(ch, div, reps, note, level, scale)")
  print("Pitch CV: ch 1-6 | Level CV: ch 7-12 | Trig: tr 1-6")
end

-- Plain values or sequins work inline:
-- launch(1)                                       -- defaults from hs.ch[1]
-- launch(1, 8, 4, 2)                              -- 8th notes, 4 reps, degree 2
-- launch(1, s{4,3,4,6}, s{3,5}, s{0,4,7}, s{5,8}, scales.major)
-- hs.ch[1].note = s{0,4,7}                        -- swap note pattern live
-- hs.ch[2].scale = scales.pentatonic              -- swap scale live
-- hs.quantize = 16                                -- snap all events to 16th note grid
-- hs.quantize = 0                                 -- deactivate quantization
-- stop(1)
-- stop_all()
