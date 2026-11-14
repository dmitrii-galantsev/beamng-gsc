-- Mock BeamNG vehicle VM + a miniature copy of the stock arcade shift logic, to run the compiled quickShift.lua end to end.
-- The mini logic keeps the stock rules that matter (see controller/vehicleController/shiftLogic/automaticGearbox.lua):
--   downshift: gearChangeDelayTimer == 0, rpm < shiftDownAV(drivingAggression), |throttle - smoothedThrottle| < throttleUpShiftThreshold
--   D -> N -> R: smoothed brake > 0.1, smoothed throttle input <= 0, smoothed avgAV <= 0.15, neutral timer == 0
--   R -> D:      smoothed throttle > 0, smoothed brake <= 0, smoothed avgAV > -1, neutral timer == 0
--   gamepad aggression held 2.25 s after lift-off, then decays; the logic swaps its own update function while shifting.
-- Every scenario runs twice (stock only / with the mod); the output is compared with expected/harness.txt.
local SCRIPT = ...
local abs, min, max, exp, pi = math.abs, math.min, math.max, math.exp, math.pi
local DT = 1 / 60
local WHEEL_R, FINAL = 0.32, 3.7
local RATIOS = {3.5, 2.2, 1.5, 1.1, 0.9, 0.75}
local out = {}
local function say(fmt, ...) out[#out + 1] = string.format(fmt, ...) end
local function clamp(x, a, b) return x < a and a or (x > b and b or x) end

local function newWorld(withMod)
  local w = {t = 0, speed = 0, mode = "D", pedals = {throttle = 0, brake = 0}, aiDriving = false, log = {}}
  local iv = {throttle = 0, brake = 0}
  local sm = {throttle = 0, brake = 0, throttleInput = 0, brakeInput = 0, drivingAggression = 0, throttleUpShiftThreshold = 0.05, avgAV = 0}
  local timer = {gearChangeDelayTimer = 0, neutralSelectionDelayTimer = 0}
  local tc = {gearChangeDelay = 0.5, neutralSelectionDelay = 0.5}
  local gearbox = {gearIndex = 1}
  local L = {smoothedValues = sm, timer = timer, timerConstants = tc, inputValues = iv, gearboxHandling = {behavior = "arcade"}, throttle = 0, brake = 0, shiftPreventionData = {wheelSlipShiftUp = true}}
  local holdTimer, lastThrottle, aggressionSm = 0, 0, 0
  w.sm, w.timer, w.tc, w.gearbox, w.L = sm, timer, tc, gearbox, L

  local function rpmFor(g) return abs(w.speed) / WHEEL_R * RATIOS[g] * FINAL * 60 / (2 * pi) end
  function L.getGearName() return w.mode end

  local inGear, whileShifting
  whileShifting = function()
    gearbox.gearIndex = L.newDesired
    L.newDesired = nil
    timer.gearChangeDelayTimer = tc.gearChangeDelay
    L.updateGearboxGFX = inGear
  end
  inGear = function()
    if not L.shiftPreventionData.wheelSlipShiftUp then w.sawBlocked = true end
    local thr, brk = iv.throttle, iv.brake
    if gearbox.gearIndex < 0 and sm.avgAV <= 0.8 then thr, brk = brk, thr end
    L.throttle, L.brake = thr, brk
    local gi = gearbox.gearIndex
    local target = gi
    if timer.gearChangeDelayTimer <= 0 and w.mode ~= "N" and gi > 0 then
      local coef = clamp((sm.drivingAggression - 0.2) / 0.8, 0, 1) ^ 2
      local down, up = 1500 + 2000 * coef, 2500 + 3000 * coef
      local gate = abs(thr - sm.throttle) < sm.throttleUpShiftThreshold
      local g, rpm = gi, rpmFor(gi)
      while rpm < down and g > 1 and gate do
        g = g - 1
        rpm = rpmFor(g)
      end
      if rpm >= up and brk <= 0 and gate and L.shiftPreventionData.wheelSlipShiftUp and g < 6 and rpmFor(g + 1) >= 880 then g = g + 1 end
      target = g
    end
    if abs(gi) <= 1 and timer.neutralSelectionDelayTimer <= 0 then
      if w.mode ~= "N" and abs(sm.avgAV) < 5 and thr <= 0 and sm.throttle <= 0 then
        target, w.mode = 0, "N"
      else
        if sm.throttleInput > 0 and iv.throttle > 0 and sm.brakeInput <= 0 and sm.avgAV > -1 and target < 1 then
          target, w.mode = 1, "D"
          timer.neutralSelectionDelayTimer = tc.neutralSelectionDelay
        end
        if sm.brakeInput > 0.1 and iv.brake > 0 and sm.throttleInput <= 0 and sm.avgAV <= 0.15 and target > -1 then
          target, w.mode = -1, "R"
          timer.neutralSelectionDelayTimer = tc.neutralSelectionDelay
        end
      end
    end
    if gearbox.gearIndex ~= target then
      L.newDesired = target
      L.updateGearboxGFX = whileShifting
    end
  end
  L.updateGearboxGFX = inGear
  w.rawInGear = inGear

  local function toward(cur, target, up, down, dt)
    if target > cur then return min(cur + up * dt, target) end
    return max(cur - down * dt, target)
  end

  -- one frame in the order of the real game: controller (vehicleController.updateGFXGeneric), then extensions, then physics
  function w.step()
    local dt = DT
    iv.throttle, iv.brake = w.pedals.throttle, w.pedals.brake
    local rawAV = w.speed / WHEEL_R * FINAL
    sm.avgAV = sm.avgAV + (rawAV - sm.avgAV) * (1 - exp(-dt / 0.3))
    timer.gearChangeDelayTimer = max(timer.gearChangeDelayTimer - dt, 0)
    timer.neutralSelectionDelayTimer = max(timer.neutralSelectionDelayTimer - dt, 0)
    L.updateGearboxGFX(dt)
    sm.throttle = toward(sm.throttle, L.throttle, 2, 5, dt)
    sm.brake = toward(sm.brake, L.brake, 2, 5, dt)
    sm.throttleInput = toward(sm.throttleInput, iv.throttle, 4, 10, dt)
    sm.brakeInput = toward(sm.brakeInput, iv.brake, 4, 10, dt)
    if iv.throttle <= 0 then holdTimer = max(holdTimer - dt, 0) else holdTimer = 2.25 end
    local hold = L.brake > 0.25 or (iv.throttle <= 0 and abs(w.speed) > 2 and holdTimer > 0)
    local dThr = clamp((iv.throttle - lastThrottle) / dt, 1, 20)
    local raw = hold and sm.drivingAggression or iv.throttle * 1.333 * dThr
    if abs(w.speed) < 1 then raw = 0 end
    aggressionSm = toward(aggressionSm, raw, 1.5, 1, dt)
    sm.drivingAggression = min(aggressionSm, 1)
    lastThrottle = iv.throttle
    if w.mod then w.mod.updateGFX(dt) end
    if w.mod2 then w.mod2.updateGFX(dt) end
    -- physics
    local g = gearbox.gearIndex
    local v = w.speed
    if g > 0 then v = v + (3 * L.throttle - 0.8 * (L.throttle <= 0 and 1 or 0)) * dt
    elseif g < 0 then v = v - 3 * L.throttle * dt end
    if L.brake > 0 then
      if v > 0 then v = max(0, v - 6 * L.brake * dt) elseif v < 0 then v = min(0, v + 6 * L.brake * dt) end
    end
    if w.hold ~= nil then v = w.hold end
    w.speed = v
    w.t = w.t + dt
  end

  -- fake game globals read by the mod
  gearbox.type = "automaticGearbox"
  package.loaded["controller/vehicleController/shiftLogic/automaticGearbox"] = L
  _G.powertrain = {getDevice = function(name) if name == "gearbox" then return gearbox end end}
  _G.obj = {getVelocity = function() return {x = 0, y = w.speed, z = 0} end, getDirectionVector = function() return {x = 0, y = 1, z = 0} end}
  _G.electrics = {values = {}}
  _G.playerInfo = {anyPlayerSeated = true}
  _G.ai = {isDriving = function() return w.aiDriving end}
  _G.FS = {fileExists = function() return false end}
  _G.jsonReadFile = function() return nil end
  _G.log = function(level, tag, msg) w.log[#w.log + 1] = level .. " " .. tag .. " " .. msg end
  if withMod then
    local M = assert(loadfile(SCRIPT))()
    assert(M.onExtensionLoaded() == true)
    M.onVehicleLoaded()
    w.mod = M
  end
  return w
end

local function runFor(w, seconds) for _ = 1, math.floor(seconds / DT + 0.5) do w.step() end end

-- 1) coasting: cruise at 30 m/s in 6th on a light throttle, then lift off and slow down at ~0.8 m/s2
local function coast(withMod)
  local w = newWorld(withMod)
  w.speed, w.gearbox.gearIndex, w.pedals.throttle = 30, 6, 0.3
  w.hold = 30
  runFor(w, 5)
  w.hold = nil
  w.pedals.throttle = 0
  local shifts, last = {}, w.gearbox.gearIndex
  local t0 = w.t
  for _ = 1, math.floor(12 / DT) do
    w.step()
    if w.gearbox.gearIndex ~= last then
      shifts[#shifts + 1] = string.format("%d>%d@%.2fs", last, w.gearbox.gearIndex, w.t - t0)
      last = w.gearbox.gearIndex
    end
  end
  return shifts, w
end

-- 2) stopped (creeping) in D, press the brake: time until the box is in R
local function toReverse(withMod)
  local w = newWorld(withMod)
  w.speed, w.gearbox.gearIndex, w.pedals.brake = 0.4, 1, 0.8
  for i = 1, math.floor(4 / DT) do
    w.step()
    if w.gearbox.gearIndex < 0 then return w.t, w end
  end
  return nil, w
end

-- 3) rolling backwards at 2 m/s in R, press the throttle: time until the box is in D
local function toDrive(withMod)
  local w = newWorld(withMod)
  w.speed, w.gearbox.gearIndex, w.mode, w.pedals.throttle = -2, -1, "R", 0.9
  w.sm.avgAV = -2 / WHEEL_R * FINAL
  for i = 1, math.floor(4 / DT) do
    w.step()
    if w.gearbox.gearIndex > 0 then return w.t, w end
  end
  return nil, w
end

local sBase = coast(false)
local sMod, wMod = coast(true)
say("coast, lifted at 30 m/s in 6th (shifts after lift-off)")
say("  stock      : %s", #sBase > 0 and table.concat(sBase, " ") or "none")
say("  quickShift : %s", #sMod > 0 and table.concat(sMod, " ") or "none")
local function firstTime(list) return list[1] and tonumber(list[1]:match("@([%d%.]+)s")) or 99 end
assert(#sMod >= #sBase, "mod must not downshift less")
assert(firstTime(sMod) < firstTime(sBase) - 0.15 or #sBase == 0 and #sMod > 0, "mod must downshift sooner")
local modLog = {}
for _, l in ipairs(wMod.log) do if l:find("coast downshift", 1, true) then modLog[#modLog + 1] = l end end
say("  log lines  : %d coast downshift entries", #modLog)
assert(#modLog >= 1, "coast downshifts are logged")

local tBaseR = toReverse(false)
local tModR, wR = toReverse(true)
say("brake from creeping in D -> gear R:  stock %s  quickShift %s", tBaseR and string.format("%.2fs", tBaseR) or "never", tModR and string.format("%.2fs", tModR) or "never")
assert(tModR and (tBaseR == nil or tModR < tBaseR - 0.3), "mod must reach R sooner")

local tBaseD = toDrive(false)
local tModD, wD = toDrive(true)
say("throttle while rolling back 2 m/s in R -> gear D:  stock %s  quickShift %s", tBaseD and string.format("%.2fs", tBaseD) or "never", tModD and string.format("%.2fs", tModD) or "never")
assert(tModD and (tBaseD == nil or tModD < tBaseD - 0.3), "mod must reach D sooner")

-- hook housekeeping: wrapped now, restored when switched off, back when switched on
local st = wD.mod.getState()
say("state with mod: attached=%s hooked=%s neutralDelay=%.2f", tostring(st.attached), tostring(st.hooked), wD.tc.neutralSelectionDelay)
assert(st.attached and st.hooked and abs(wD.tc.neutralSelectionDelay - 0.1) < 1e-9)
wD.mod.setEnabled(false)
wD.step()
say("disabled: neutralDelay=%.2f gate=%.2f hookedFn=%s", wD.tc.neutralSelectionDelay, wD.sm.throttleUpShiftThreshold, tostring(wD.L.updateGearboxGFX == wD.rawInGear))
assert(wD.tc.neutralSelectionDelay == 0.5 and wD.sm.throttleUpShiftThreshold == 0.05, "stock values restored")
assert(not wD.mod.getState().hooked, "hook removed")
wD.mod.setEnabled(true)
runFor(wD, 1)
assert(wD.mod.getState().attached, "re-attaches after being enabled again")

-- the controller rebuilding its tables (re-init) must not leave the mod dead
local w2 = newWorld(true)
w2.speed, w2.gearbox.gearIndex = 20, 4
runFor(w2, 1)
w2.L.smoothedValues = {throttle = 0, brake = 0, throttleInput = 0, brakeInput = 0, drivingAggression = 0, throttleUpShiftThreshold = 0.05, avgAV = 0}
w2.sm = w2.L.smoothedValues
runFor(w2, 3)
say("after the controller rebuilt its tables: attached=%s", tostring(w2.mod.getState().attached))
assert(w2.mod.getState().attached, "must re-attach after the controller rebuilt its tables")

-- AI-driven or empty vehicles keep stock behaviour
local w3 = newWorld(true)
w3.speed, w3.gearbox.gearIndex = 25, 6
w3.aiDriving = true
runFor(w3, 2)
say("AI driving: neutralDelay=%.2f hooked-avgMode=%d", w3.tc.neutralSelectionDelay, w3.mod.getState().avgMode)
assert(w3.tc.neutralSelectionDelay == 0.5, "AI-driven cars keep the stock delay")

-- two copies of the extension in one VM (hand-loaded + auto-loaded) used to wrap each other's hook and overflow the
-- Lua stack in the game: only one may hook, the other waits and takes over if the first is unloaded
local w4 = newWorld(true)
w4.speed, w4.gearbox.gearIndex = 25, 5
local M2 = assert(loadfile(SCRIPT))()
assert(M2.onExtensionLoaded() == true)
M2.onVehicleLoaded()
w4.mod2 = M2
local okRun, errRun = pcall(runFor, w4, 4)
assert(okRun, "two copies must not crash: " .. tostring(errRun))
local h1, h2 = w4.mod.getState().hooked, M2.getState().hooked
say("two copies: first hooked=%s second hooked=%s", tostring(h1), tostring(h2))
assert(h1 ~= h2, "exactly one copy hooks the shift logic")
local warnings = 0
for _, l in ipairs(w4.log) do if l:find("another copy", 1, true) then warnings = warnings + 1 end end
assert(warnings == 1, "the idle copy says so once")
local owner, other = w4.mod, M2
if M2.getState().hooked then owner, other = M2, w4.mod end
owner.onExtensionUnloaded()
runFor(w4, 3)
say("owner unloaded: other attached=%s hooked=%s, stock fn restored first=%s", tostring(other.getState().attached), tostring(other.getState().hooked), tostring(w4.L.updateGearboxGFX ~= nil))
assert(other.getState().attached and other.getState().hooked, "the waiting copy takes over")
assert(w4.tc.neutralSelectionDelay == 0.1, "and applies its settings")

-- the hold after an assisted downshift forbids upshifts through shiftPreventionData for that one call only
local wc, wcShifts = newWorld(true), nil
wc.speed, wc.gearbox.gearIndex, wc.pedals.throttle = 30, 6, 0.3
wc.hold = 30
runFor(wc, 5)
wc.hold = nil
wc.pedals.throttle = 0
runFor(wc, 6)
say("upshift block: seen by the logic=%s, restored afterwards=%s", tostring(wc.sawBlocked == true), tostring(wc.L.shiftPreventionData.wheelSlipShiftUp == true))
assert(wc.sawBlocked, "the logic must see wheelSlipShiftUp == false while the hold runs")
assert(wc.L.shiftPreventionData.wheelSlipShiftUp == true, "and the controller's value is put back after the call")

-- the shifter mode was switched: the module we hooked is no longer called, the active one is another module
local w5 = newWorld(false)
local stale = {smoothedValues = w5.sm, timer = w5.timer, timerConstants = w5.tc, inputValues = {}, shiftBehavior = {}, updateGearboxGFX = function() end}
package.loaded["controller/vehicleController/shiftLogic/manualGearbox"] = stale
local M5 = assert(loadfile(SCRIPT))()
assert(M5.onExtensionLoaded() == true)
M5.onVehicleLoaded()
w5.mod = M5
w5.speed, w5.gearbox.gearIndex = 25, 5
w5.hold = 25
runFor(w5, 6)
package.loaded["controller/vehicleController/shiftLogic/manualGearbox"] = nil
say("stale module: hooked the live one=%s", tostring(M5.getState().hooked and w5.L.updateGearboxGFX ~= w5.rawInGear))
assert(M5.getState().hooked and w5.L.updateGearboxGFX ~= w5.rawInGear, "must end up on the module the controller really runs")
assert(stale.updateGearboxGFX ~= nil and stale.qsOwner == nil, "and let go of the stale one")

-- a one-frame blip of the gear index is not a gear change
local w6 = newWorld(true)
w6.speed, w6.gearbox.gearIndex = 30, 5
w6.hold = 30
w6.L.currentGearIndex = 5
runFor(w6, 2)
w6.L.currentGearIndex = 4
w6.step()
w6.L.currentGearIndex = 5
runFor(w6, 1)
local blips, downs = 0, 0
for _, l in ipairs(w6.log) do
  if l:find("one-frame gear blip", 1, true) then blips = blips + 1 end
  if l:find("coast downshift", 1, true) then downs = downs + 1 end
end
say("gear blip: ignored=%d reported downshifts=%d", blips, downs)
assert(blips == 1 and downs == 0, "a one-frame gear blip is ignored and logged once")

print(table.concat(out, "\n"))
print("OK")
