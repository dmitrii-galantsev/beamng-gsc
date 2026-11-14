-- Scenario test for the parts of agaSteering the bicycle-model harnesses (h2..h5) never reach:
-- persistence of learned tyre data (jsonWriteFile / restore), config reload, the console API, the module's
-- table shape, wheel discovery fallbacks, unsupported vehicles, pre-load hook calls, debug graph output.
-- The car is purely kinematic and open loop (the script's steering output only moves the wheels during the
-- standstill sweep), so two implementations always see identical inputs and their logs can be compared exactly.
-- Prints a log; scripts/integration.mjs diffs it between the original Lua and the compiled build.
local SCRIPT = ...

local function num(x) if type(x) == "number" then return string.format("%.17g", x) end return tostring(x) end
local function sortedKeys(t) local ks = {} for k in pairs(t) do ks[#ks + 1] = tostring(k) end table.sort(ks) return ks end
local function flat(t)
  if type(t) ~= "table" then return num(t) end
  local parts = {}
  if #t > 0 then for _, x in ipairs(t) do parts[#parts + 1] = flat(x) end
  else for _, k in ipairs(sortedKeys(t)) do parts[#parts + 1] = k .. "=" .. flat(t[k]) end end
  return "{" .. table.concat(parts, ",") .. "}"
end
local function copy(t) if type(t) ~= "table" then return t end local r = {} for k, x in pairs(t) do r[k] = copy(x) end return r end

table.clear = table.clear or function(t) for k in pairs(t) do t[k] = nil end end
FILTER_KBD, FILTER_PAD, FILTER_DIRECT, FILTER_KBD2 = 0, 1, 2, 3

local LOG = {}
local function out(s) LOG[#LOG + 1] = s; print(s) end
local failures = 0
local function check(cond, what) if not cond then failures = failures + 1 end out((cond and "ok   " or "FAIL ") .. what) end

local STORE = {}      -- virtual file system: path -> data
local writes = 0
local writeFails = false
local graphCalls = 0
guihooks = {
  message = function(m, ttl, cat) out("  gui: " .. m .. " ttl=" .. num(ttl) .. " cat=" .. tostring(cat)) end,
  graph = function(...) graphCalls = graphCalls + 1; if graphCalls == 1 then out("  graph: " .. flat({...})) end end
}
log = function(l, tag, m) out("  log " .. l .. " " .. tag .. ": " .. m) end
dumps = function(t) local s = {} for _, x in ipairs(t) do s[#s + 1] = string.format("%.4f", x) end return "{" .. table.concat(s, ",") .. "}" end
jsonReadFile = function(p) return copy(STORE[p]) end
jsonWriteFile = function(p, data, pretty)
  writes = writes + 1
  if writeFails then return false end
  STORE[p] = copy(data)
  out("  write " .. p .. " pretty=" .. tostring(pretty) .. " " .. flat(data))
  return true
end
FS = {fileExists = function(self, p) assert(self == FS, "FS.fileExists must be colon-called"); return STORE[p] ~= nil end}
particles = {getMaterialsParticlesTable = function() return {[10] = {name = "ASPHALT"}, [11] = {name = "GRASS"}, [12] = 5} end}
playerInfo = {anyPlayerSeated = true}
ai = {isDriving = function() return false end}
sensors = {gx2 = 0, gy2 = 0}
v = {config = {model = "testcar", partsTree = {chosenPartName = "testcar_body", children = {
  a = {chosenPartName = "tire_R_255_40_18_sport"}, b = {chosenPartName = "tire_F_225_45_18_sport", children = {x = {chosenPartName = "tire_F_225_45_18_sport"}}},
  c = {chosenPartName = "wheel_F_18x8"}, d = {chosenPartName = 7}}}}}

-- kinematic car: forward +y, right +x, speed u, yaw rate r (right positive), front wheel angle delta (deg, right positive)
local car = {u = 0, r = 0, delta = 0, lock = 30, steerGain = 1, rearSteer = 0, L = 2.7, mat = 10, fz = 3500}
local wheelDefs
local nodeOf = {}
local function buildWheels(names)
  wheelDefs = {
    {name = names[1], lx = -0.75, ly = 1.2, front = true}, {name = names[2], lx = 0.75, ly = 1.2, front = true},
    {name = names[3], lx = -0.75, ly = -1.5, front = false}, {name = names[4], lx = 0.75, ly = -1.5, front = false}}
  wheels = {wheels = {}}
  nodeOf = {}
  for i, w in ipairs(wheelDefs) do
    w.node1, w.node2 = (i - 1) * 2, (i - 1) * 2 + 1
    w.downForceRaw, w.contactMaterialID1, w.contactMaterialID2, w.wheelSpeed = car.fz, 10, 10, 0
    nodeOf[w.node1], nodeOf[w.node2] = {w, -1}, {w, 1}
    wheels.wheels[i - 1] = w
  end
end
local function P(x, y, z) return {x = x, y = y, z = z} end
obj = {}
GEQ = {}
function obj.queueGameEngineLua(_, s) GEQ[#GEQ + 1] = s end
function obj:getDirectionVector() assert(self == obj) return P(0, 1, 0) end
function obj:getDirectionVectorUp() return P(0, 0, 1) end
function obj:getGravity() return -9.81 end
function obj:getStaticFrictionCoef() return 1.0 end
function obj:getNodePosition(id)
  local w, side = nodeOf[id][1], nodeOf[id][2]
  local a = math.rad(w.front and car.delta or car.rearSteer)
  return P(w.lx + side * 0.1 * math.cos(a), w.ly - side * 0.1 * math.sin(a), 0.3)
end
function obj:getNodeVelocityVector(id)
  local w = nodeOf[id][1]
  return P(car.r * (w.ly + 1.5), car.u - car.r * w.lx, 0) -- rear axle has no lateral velocity
end

local CFG = nil
local M
local function load()
  electrics = {values = {}}
  input = {state = {steering = {val = 0, filter = FILTER_PAD}}}
  M = dofile(SCRIPT)
end
local function cfgFile(t) STORE["settings/agaSteering.json"] = t end

local function frame(dt, stick, sweepMovesWheels)
  input.state.steering.val = stick
  electrics.values.steering_input = stick
  for _, w in ipairs(wheelDefs) do w.wheelSpeed = car.u; w.contactMaterialID1 = car.mat; w.downForceRaw = car.fz end
  sensors.gx2 = car.r * car.u
  M.updateGFX(dt)
  if sweepMovesWheels then
    car.delta = car.lock * car.steerGain * (electrics.values.steering_input or 0)
    car.rearSteer = (car.rearGain or 0) * (electrics.values.steering_input or 0)
  end
end
local function ev()
  local e, ks, parts = electrics.values, {}, {}
  for _, k in ipairs(sortedKeys(e)) do parts[#parts + 1] = k .. "=" .. num(e[k]) end
  return table.concat(parts, " ")
end
local function state() local s = copy(M.getState()); return flat(s) end
local dt = 1 / 60
local function run(seconds, stick, sweep, digest)
  local acc = 0
  for i = 1, math.floor(seconds / dt + 0.5) do
    frame(dt, stick, sweep)
    local e = electrics.values
    acc = acc * 0.999 + (e.steering_input or 0) + (e.agaLimit or 0) * 3 + (e.agaSelfSteer or 0) * 7 + (e.agaPeakSlip or 0) * 11 + (e.agaLearnWhy or 0)
  end
  if digest then out("  digest " .. digest .. ": " .. num(acc)) end
end
local function corner(seconds, r, slipDeg)
  car.u, car.r = 20, r
  car.delta = math.deg(math.atan2(r * car.L, car.u)) + slipDeg * (r >= 0 and 1 or -1)
  run(seconds, 0.3 * (r >= 0 and 1 or -1), false, "corner r=" .. r)
end
local function stop() car.u, car.r, car.delta = 0, 0, 0 end

-- ===== 1. module shape and hooks before the vehicle is loaded ==============================================
buildWheels({"FL", "FR", "RL", "RR"})
load()
local shape = {}
for _, k in ipairs(sortedKeys(M)) do shape[#shape + 1] = k .. ":" .. type(M[k]) end
out("module: " .. table.concat(shape, " "))
check(table.concat(sortedKeys(M), ",") == "getMode,getState,onExtensionLoaded,onExtensionUnloaded,onReset,onSettingsChanged,onVehicleLoaded,recalibrate,reloadConfig,saveLearned,setEnabled,setMode,setRally,syncMode,syncRally,toggle,toggleRally,updateGFX", "module exports exactly the 18 documented functions")
check(M.onExtensionLoaded() == true, "onExtensionLoaded returns true")
out("state before load: " .. state())
M.updateGFX(dt); M.updateGFX(nil); M.updateGFX(0); M.updateGFX(0 / 0)
out("electrics before load: " .. ev())
M.onExtensionUnloaded(); M.saveLearned()
check(writes == 0, "nothing saved before anything was learned")

-- ===== 2. load, calibration sweep, electrics keys =========================================================
cfgFile({steeringRate = 0.6, filterSetting = 0.7, bogusKey = 1, targetSlip = "x", velocitySmoothing = 5, debug = false})
M.onVehicleLoaded()
out("cfg: " .. flat(M.getState().cfg))
run(6, 0, true, "sweep")
out("after sweep: " .. state())
out("electrics: " .. ev())
check(M.getState().calibrated and math.abs(M.getState().lock - 30) < 0.01, "calibrated, lock 30")

-- ===== 3. learning + persistence ==========================================================================
run(2, 0, false, "standstill")
for k = 1, 4 do corner(8, (k % 2 == 0) and 0.2 or -0.2, 2.0) end
out("after cornering: " .. state())
check(M.getState().learnSamples > 300, "estimator accepted samples")
run(31, 0.3, false, "periodic save")
check(writes >= 1, "periodic save (every 30 s of active driving) happened")
M.saveLearned()
local w0 = writes
M.saveLearned()
check(writes == w0, "no rewrite when nothing meaningful changed")
check(STORE["settings/agaSteering_learned.json"]["testcar|tire_F_225_45_18_sport,tire_R_255_40_18_sport"] ~= nil, "learned entry keyed by model|sorted tyre parts")
local learnedTarget = M.getState().targetSlip

-- ===== 4. reset / settings change ==========================================================================
stop(); M.onReset()
out("after onReset: " .. state())
check(M.getState().calibrated and M.getState().learnSamples > 0, "reset keeps calibration and learned data")
cfgFile({peakSlipDeg = 9})
M.onSettingsChanged()
out("peakSlipDeg=9: " .. state())
check(M.getState().targetSlip == 9 and M.getState().learnSamples == 0, "fixed peak slip resets learning")
corner(4, 0.2, 2.0)
w0 = writes; M.saveLearned()
check(writes == w0, "no save while peakSlipDeg is fixed")
cfgFile({learnPeakSlip = false}); M.onReset(); corner(2, 0.2, 2.0)
out("learnPeakSlip=false: " .. state())
cfgFile(nil); M.onSettingsChanged()
out("defaults again: " .. flat(M.getState().cfg))

-- ===== 5. fresh instance restores what was learned =========================================================
stop(); load(); M.onVehicleLoaded()
out("restored: " .. state())
check(math.abs(M.getState().targetSlip - learnedTarget) < 0.3 and M.getState().learnSamples == 300, "learned target restored on spawn")
STORE["settings/agaSteering_learned.json"]["testcar|tire_F_225_45_18_sport,tire_R_255_40_18_sport"] = {C0 = 1e9, muMax = -3, n = "250"}
load(); M.onVehicleLoaded()
out("restored (hostile file): " .. state())
STORE["settings/agaSteering_learned.json"] = "garbage"
load(); M.onVehicleLoaded()
out("restored (garbage file): " .. state())
STORE["settings/agaSteering_learned.json"] = nil

-- ===== 6. console API ======================================================================================
run(6, 0, true, "sweep 2")
car.u = 20; run(1, 0.5, false, "enabled")
M.setEnabled(false); run(0.5, 0.5, false, "disabled"); out("electrics: " .. ev())
check(electrics.values.steering_input == 0.5 and electrics.values.agaEnabled == 0, "setEnabled(false): passthrough")
M.onSettingsChanged(); check(M.getState().cfg.enabled == false, "override survives a config reload")
M.toggle(); check(M.getState().cfg.enabled == true, "toggle turns it back on")
M.setEnabled(nil); check(M.getState().cfg.enabled == false, "setEnabled(nil) = off")
M.setEnabled(0); check(M.getState().cfg.enabled == true, "setEnabled(0) = on (Lua truthiness)")
M.setEnabled(false); M.reloadConfig(); check(M.getState().cfg.enabled == false, "reloadConfig keeps the live mode")
-- mode API (v3.4): the car owns the mode, saves it through the game engine VM and syncs the other cars
GEQ = {}
M.setMode("rally"); check(M.getMode() == "rally" and M.getState().cfg.rally == true and M.getState().cfg.enabled == true, "setMode('rally')")
check(#GEQ == 1 and GEQ[1]:find("c.enabled=true", 1, true) ~= nil and GEQ[1]:find("c.rally=true", 1, true) ~= nil and GEQ[1]:find("a.syncMode(true,true)", 1, true) ~= nil, "setMode saves enabled+rally and syncs the other cars")
M.toggleRally(); check(M.getMode() == "grip", "toggleRally: rally -> grip")
M.setMode("off"); check(M.getMode() == "off", "setMode('off')")
M.toggleRally(); check(M.getMode() == "rally", "toggleRally from off -> rally")
M.setMode("bogus"); check(M.getMode() == "rally" and #GEQ == 4, "setMode ignores unknown modes")
M.onSettingsChanged(); check(M.getMode() == "rally", "mode survives a config reload")
M.syncMode(true, false); check(M.getMode() == "grip" and #GEQ == 4, "syncMode is quiet (no save)")
M.setRally(false); check(M.getMode() == "grip", "setRally(false) = grip")
stop(); M.recalibrate(); car.lock = 24
run(6, 0, true, "recalibrate"); out("recalibrated: " .. state())
check(math.abs(M.getState().lock - 24) < 0.01, "recalibrate measures the new lock")
car.lock = 30

-- ===== 7. input filters, AI, seat ==========================================================================
car.u = 20
input.state.steering.filter = FILTER_DIRECT; run(0.5, 0.4, false, "wheel"); check(electrics.values.steering_input == 0.4, "wheel untouched")
input.state.steering.filter = FILTER_KBD; run(0.5, 0.4, false, "kbd"); check(electrics.values.steering_input == 0.4, "keyboard untouched by default")
cfgFile({applyToKeyboard = true}); M.onSettingsChanged(); run(0.5, 0.4, false, "kbd on"); check(electrics.values.steering_input ~= 0.4, "keyboard processed with applyToKeyboard")
input.state.steering.filter = FILTER_KBD2; run(0.2, 0.4, false, "kbd2")
input.state.steering.filter = FILTER_PAD
ai.isDriving = function() return true end; run(0.2, 0.4, false, "ai"); check(electrics.values.steering_input == 0.4, "AI driving: untouched")
ai = nil; run(0.2, 0.4, false, "no ai module"); ai = {isDriving = function() return false end}
playerInfo.anyPlayerSeated = false; run(0.2, 0.4, false, "unseated"); playerInfo.anyPlayerSeated = true
input.state.steering.filter = nil; run(0.2, 0.4, false, "no filter"); input.state.steering.filter = FILTER_PAD
cfgFile({debug = true, velocitySmoothing = 0.05}); M.onSettingsChanged(); run(0.5, 0.4, false, "debug graph")
check(graphCalls == 30, "debug graph streamed every frame")
electrics.values.throttle_input = 1; electrics.values.brake_input = 0.5; run(0.5, 0.4, false, "brake"); electrics.values.throttle_input = nil; electrics.values.brake_input = nil
car.mat = 11; corner(2, 0.2, 2.0); out("  why on grass: " .. num(electrics.values.agaLearnWhy)); car.mat = 10
cfgFile(nil)

-- ===== 8. save failure is reported once ====================================================================
stop(); load(); M.onVehicleLoaded(); run(6, 0, true, "sweep 3"); run(2, 0, false, "standstill")
corner(8, 0.2, 2.0); corner(8, -0.2, 2.0)
writeFails = true; w0 = writes
M.saveLearned(); M.saveLearned()
check(writes == w0 + 2, "failed save is retried")
writeFails = false; M.onExtensionUnloaded()
check(STORE["settings/agaSteering_learned.json"] ~= nil, "onExtensionUnloaded saves")
STORE["settings/agaSteering_learned.json"] = nil

-- ===== 9. vehicles the assist cannot handle ================================================================
stop(); car.steerGain = 0; load(); M.onVehicleLoaded(); run(14, 0, true, "no steering"); out("no steering: " .. state() .. " | " .. ev())
check(M.getState().unsupported, "front wheels that do not steer -> unsupported after two tries")
car.rearGain = 20; load(); M.onVehicleLoaded(); run(8, 0, true, "rear steer"); out("rear steer: " .. state())
check(M.getState().unsupported, "rear-wheel steering -> unsupported")
car.steerGain, car.rearGain, car.rearSteer = 1, nil, 0
car.steerGain = -1; load(); M.onVehicleLoaded(); run(6, 0, true, "inverted"); out("inverted: " .. state())
check(M.getState().sign == -1, "inverted steering_input convention detected")
car.steerGain = 1

-- ===== 10. wheel discovery ================================================================================
stop(); buildWheels({"A", "B", "C", "D"}); load(); M.onVehicleLoaded()
check(M.getState().ready and M.getState().wheelsByPosition, "wheels without F/R names are split by position")
run(6, 0, true, "by position"); out("by position: " .. state())
buildWheels({"FL", "FR", "RL", "RR"}); wheelDefs[1].isBroken = true; M.onReset(); car.u = 20; run(0.5, 0.4, false, "broken FL"); wheelDefs[1].isBroken = nil
local saved = wheels; wheels = {wheels = {[0] = saved.wheels[0], [1] = "junk", [2] = {name = "RL"}}}
load(); M.onVehicleLoaded(); check(not M.getState().ready, "not ready with a single usable wheel")
run(1, 0.4, false, "not ready"); wheels = saved
run(7, 0.4, false, "late wheels"); check(M.getState().ready, "wheel discovery is retried while not ready")
wheels = {}; load(); M.onVehicleLoaded(); run(0.2, 0.4, false, "no wheel table"); wheels = saved
v = nil; stop(); load(); M.onVehicleLoaded(); run(6, 0, true, "sweep, no vehicle data"); run(2, 0, false, "standstill"); corner(8, 0.2, 2.0)
w0 = writes; M.saveLearned(); check(writes == w0, "no vehicle data -> nothing to key the learned data on")
FS = nil; particles = nil; load(); M.onVehicleLoaded(); run(6, 0, true, "sweep, no FS/particles"); corner(2, 0.2, 2.0)
out("no FS/particles: " .. state())

out(failures == 0 and "API SCENARIO: all checks passed" or ("API SCENARIO: " .. failures .. " check(s) FAILED"))
if failures > 0 then error("api scenario failed") end
