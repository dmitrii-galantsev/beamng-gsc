-- Minimal BeamNG vehicle-Lua mock + bicycle-model car to exercise agaSteering.lua
local SCRIPT = ...
-- vec3
local V = {}; V.__index = V
function vec3(x, y, z) return setmetatable({x = x or 0, y = y or 0, z = z or 0}, V) end
function V:set(a, b, c) if type(a) == "table" then self.x, self.y, self.z = a.x, a.y, a.z else self.x, self.y, self.z = a, b, c end return self end
function V:dot(o) return self.x * o.x + self.y * o.y + self.z * o.z end
function V:cross(o) return vec3(self.y * o.z - self.z * o.y, self.z * o.x - self.x * o.z, self.x * o.y - self.y * o.x) end
function V:length() return math.sqrt(self:dot(self)) end
function V:normalize() local l = self:length() if l > 0 then self.x, self.y, self.z = self.x / l, self.y / l, self.z / l end return self end
function V:setAdd(o) self.x, self.y, self.z = self.x + o.x, self.y + o.y, self.z + o.z end
function V:setSub(o) self.x, self.y, self.z = self.x - o.x, self.y - o.y, self.z - o.z end
function V:setScaled(s) self.x, self.y, self.z = self.x * s, self.y * s, self.z * s end
table.clear = table.clear or function(t) for k in pairs(t) do t[k] = nil end end
FILTER_KBD, FILTER_PAD, FILTER_DIRECT, FILTER_KBD2 = 0, 1, 2, 3
MSGS = {}
guihooks = {message = function(m) table.insert(MSGS, m) end, graph = function() end}
log = function(l, t, m) table.insert(MSGS, l .. " " .. m) end
dumps = function(t) local s = {} for i, v in ipairs(t) do s[#s + 1] = string.format("%.3f", v) end return "{" .. table.concat(s, ",") .. "}" end
jsonReadFile = function() return nil end
particles = {getMaterialsParticlesTable = function() return {[10] = {name = "ASPHALT"}} end}
playerInfo = {anyPlayerSeated = true}
ai = {isDriving = function() return false end}
electrics = {values = {}}
input = {state = {steering = {val = 0, filter = FILTER_PAD}}}
sensors = {gx2 = 0, gy2 = 0}

-- ===== car model (bicycle, nonlinear tyres) ======================================
local car = {x = 0, y = 0, psi = 0, vx = 0, vy = 0, r = 0, delta = 0}
local P = {m = 1400, Iz = 2200, a = 1.2, b = 1.5, track = 1.5, lockDeg = 33, rackRate = 1.6, mu = 1.0, peakDeg = 8, Bshape = 1.6}
local g = 9.81
local function tyreFy(alpha, Fz, muK) -- simple magic formula; peak at P.peakDeg
  local C = P.Bshape
  local B = math.tan(math.pi / (2 * C)) / math.rad(P.peakDeg)
  return P.mu * (muK or 1) * Fz * math.sin(C * math.atan(B * alpha))
end
local steerCmd = 0 -- hydro target in [-1,1], rack is rate limited
local rack = 0
-- steering geometry: nonlinear input->angle (like a real rack)
local function inputToAngle(u) return P.lockDeg * (math.abs(u) ^ 1.15) * (u < 0 and -1 or 1) end

-- world basis
local function basis() local c, s = math.cos(car.psi), math.sin(car.psi) return vec3(-s, c, 0), vec3(c, s, 0) end -- fwd, right... (psi=0 -> fwd +y, right +x)
local wheelsList = {}
local function mkWheel(name, lx, lz, steer) return {name = name, lx = lx, lz = lz, steer = steer, node1 = #wheelsList * 2, node2 = #wheelsList * 2 + 1, downForceRaw = 0, contactMaterialID1 = 10, contactMaterialID2 = 10, wheelSpeed = 0} end
for i0, w in ipairs({mkWheel("FL", -0.75, P.a, true), mkWheel("FR", 0.75, P.a, true), mkWheel("RL", -0.75, -P.b, false), mkWheel("RR", 0.75, -P.b, false)}) do w.node1, w.node2 = (i0-1)*2, (i0-1)*2+1; table.insert(wheelsList, w) end
wheels = {wheels = {}}
for i, w in ipairs(wheelsList) do wheels.wheels[i - 1] = w end
local nodeOf = {}
for _, w in ipairs(wheelsList) do nodeOf[w.node1] = {w, -1}; nodeOf[w.node2] = {w, 1} end

local function localToWorld(lx, lz) local f, rgt = basis() return vec3(rgt.x * lx + f.x * lz, rgt.y * lx + f.y * lz, 0) end
obj = {}
function obj:getDirectionVector() local f = basis() return f end
function obj:getDirectionVectorUp() return vec3(0, 0, 1) end
function obj:getGravity() return -g end
function obj:getStaticFrictionCoef() return P.mu end
function obj:getNodePosition(id)
  local w, side = nodeOf[id][1], nodeOf[id][2]
  local ang = w.steer and math.rad(car.delta) or 0
  -- spin axis in local frame: rotate (1,0) by steer angle (positive delta = toe right => axis rotates clockwise)
  local ax, az = math.cos(ang), -math.sin(ang)
  return localToWorld(w.lx + side * 0.1 * ax, w.lz + side * 0.1 * az)
end
function obj:getNodeVelocityVector(id)
  local w = nodeOf[id][1]
  -- local velocity at hub: v + r x p   (r positive = clockwise from above = yaw right)
  local lvx = car.vx + car.r * w.lz
  local lvz = car.vy - car.r * w.lx
  return localToWorld(lvx, lvz)
end

-- dynamics step; car.vx = lateral (right), car.vy = forward
local function step(dt, throttleAccel)
  -- rack
  local d = steerCmd - rack
  rack = rack + math.max(-P.rackRate * dt, math.min(P.rackRate * dt, d))
  car.delta = inputToAngle(rack)
  local u = math.max(car.vy, 0.5)
  local Fzf = P.m * g * P.b / (P.a + P.b)
  local Fzr = P.m * g * P.a / (P.a + P.b)
  local af = math.rad(car.delta) - math.atan2(car.vx + car.r * P.a, u)
  local ar = -math.atan2(car.vx - car.r * P.b, u)
  local Ff, Fr = tyreFy(af, Fzf), tyreFy(ar, Fzr, P.rearMu or 1)
  local ay = (Ff * math.cos(math.rad(car.delta)) + Fr) / P.m
  car.vx = car.vx + (ay - car.r * u) * dt
  car.r = car.r + ((Ff * math.cos(math.rad(car.delta)) * P.a - Fr * P.b) / P.Iz) * dt
  car.vy = car.vy + (throttleAccel or 0) * dt
  sensors.gx2 = ay; sensors.gy2 = throttleAccel or 0
  for _, w in ipairs(wheelsList) do w.downForceRaw = (w.lz > 0 and Fzf or Fzr) / 2; w.wheelSpeed = car.vy end
  return math.deg(af), math.deg(ar), ay
end

local M = dofile(SCRIPT)
M.onVehicleLoaded()

local function frame(dt, stick, accel)
  input.state.steering.val = stick
  electrics.values.steering_input = stick -- what BeamNG would have produced
  M.updateGFX(dt)
  steerCmd = electrics.values.steering_input
  local af, ar, ay
  for i = 1, 8 do af, ar, ay = step(dt / 8, accel) end
  return af, ar, ay
end

local dt = 1 / 60
-- 1) standstill calibration
for i = 1, 600 do frame(dt, 0, 0) end
local st = M.getState()
print(string.format("calib lock=%.2f (true %.1f)  curve=%s", st.lock, P.lockDeg, dumps(st.curve)))
for _, m in ipairs(MSGS) do print("  msg:", m) end


P.rearMu = 1.12
local function run(label, enabled, stickFn, init, T)
  M.setEnabled(enabled); M.onReset()
  car.vx, car.r, car.vy = init[1], init[2], init[3]; rack = 0; steerCmd = 0; car.delta = 0
  local out1, maxAbsR, finalR, af, ar, ay = nil, 0, 0
  for i = 1, T do
    local st = stickFn(i*dt)
    if enabled then af, ar, ay = frame(dt, st, 0) else input.state.steering.val = st; steerCmd = st; for j=1,8 do af,ar,ay = step(dt/8,0) end end
    if i == 6 then out1 = steerCmd end
    if i > T/2 then maxAbsR = math.max(maxAbsR, math.abs(car.r)) end
  end
  print(string.format("%-34s %s  cmd@0.1s=%6.3f  final: af=%6.2f ar=%6.2f ay=%.2fg r=%.3f bodyslip=%.1f  late|r|max=%.3f", label, enabled and "ON " or "OFF", out1, af, ar, ay/9.81, car.r, math.deg(math.atan2(car.vx, car.vy)), maxAbsR))
end
for _, en in ipairs({true,false}) do
  run("full lock @25 (understeery car)", en, function() return 1 end, {0,0,25}, 300)
  run("half stick @25", en, function() return 0.5 end, {0,0,25}, 300)
  run("slide R-yaw, stick released", en, function() return 0 end, {-4,0.6,20}, 300)
  run("slide R-yaw, stick held right", en, function() return 1 end, {-4,0.6,20}, 300)
  run("lane change @30", en, function(t) if t<0.4 then return 0.6 elseif t<0.8 then return -0.6 else return 0 end end, {0,0,30}, 300)
end
