-- Extended scenarios for agaSteering.lua: generalized bicycle model (reverse-capable), configurable steering
-- sign convention, Ackermann, hydro rate, wheel names, rear-steer, broken wheels, airborne, frame rate.
local SCRIPT = ...
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
CFG = nil
guihooks = {message = function(m) table.insert(MSGS, tostring(m)) end, graph = function() end}
log = function(l, t, m) table.insert(MSGS, l .. " " .. tostring(m)) end
dumps = function(t) local s = {} for i, v in ipairs(t) do s[#s + 1] = string.format("%.3f", v) end return "{" .. table.concat(s, ",") .. "}" end
jsonReadFile = function() return CFG end
particles = {getMaterialsParticlesTable = function() return {[10] = {name = "ASPHALT"}} end}
playerInfo = {anyPlayerSeated = true}
ai = {isDriving = function() return false end}
local g = 9.81

local function isnan(x) return x ~= x or x == math.huge or x == -math.huge end

-- builds a fresh world + fresh module instance
local function newSim(o)
  o = o or {}
  local P = {m = 1400, Iz = 2200, a = 1.2, b = 1.5, lockDeg = o.lockDeg or 33, rackRate = o.rackRate or 1.6, mu = 1.0,
             peakDeg = o.peakDeg or 8, Bshape = 1.6, rearMu = o.rearMu or 1.12}
  local S = {P = P, car = {vx = 0, vy = 0, r = 0, delta = 0, psi = 0.3}, rack = 0, steerCmd = 0, airborne = false, nan = false, t = 0}
  local car = S.car
  local sign = o.signInv and -1 or 1          -- steering_input sign convention: +1 => positive input steers right
  local ack = o.ackermann or 0
  local zeroOff = o.zeroOffsetDeg or 0         -- measurement-only toe offset on both front wheels
  CFG = o.cfg
  MSGS = {}
  electrics = {values = {}}
  input = {state = {steering = {val = 0, filter = o.filter or FILTER_PAD}}}
  sensors = {gx2 = 0, gy2 = 0}
  playerInfo.anyPlayerSeated = true

  local function tyreFy(alpha, Fz, muK)
    local C = P.Bshape
    local B = math.tan(math.pi / (2 * C)) / math.rad(P.peakDeg)
    return P.mu * (muK or 1) * Fz * math.sin(C * math.atan(B * alpha))
  end
  local function inputToAngle(u) return sign * P.lockDeg * (math.abs(u) ^ 1.15) * (u < 0 and -1 or 1) end
  local function basis() local c, s = math.cos(car.psi), math.sin(car.psi) return vec3(-s, c, 0), vec3(c, s, 0) end
  local function localToWorld(lx, lz) local f, rgt = basis() return vec3(rgt.x * lx + f.x * lz, rgt.y * lx + f.y * lz, 0) end

  local names = o.names or {"FL", "FR", "RL", "RR"}
  local defs = {{-0.75, P.a, "f"}, {0.75, P.a, "f"}, {-0.75, -P.b, "r"}, {0.75, -P.b, "r"}}
  local wl, nodeOf = {}, {}
  wheels = {wheels = {}}
  for i, df in ipairs(defs) do
    local w = {name = names[i], lx = df[1], lz = df[2], axle = df[3], node1 = (i - 1) * 2, node2 = (i - 1) * 2 + 1, downForceRaw = 0,
               contactMaterialID1 = 10, contactMaterialID2 = 10, wheelSpeed = 0, isBroken = false}
    wl[i] = w; wheels.wheels[i - 1] = w
    nodeOf[w.node1] = {w, -1}; nodeOf[w.node2] = {w, 1}
  end
  S.wl = wl
  local steeredAxle = o.rearSteer and "r" or "f"
  local function wheelAngleRad(w)
    if w.axle ~= steeredAxle then return 0 end
    local dlt = car.delta
    -- Ackermann: inner wheel steers more
    local inner = (dlt > 0 and w.lx > 0) or (dlt < 0 and w.lx < 0)
    dlt = dlt * (1 + (inner and ack or -ack)) + (w.axle == "f" and zeroOff or 0)
    return math.rad(dlt)
  end
  obj = {}
  function obj:getDirectionVector() local f = basis() return f end
  function obj:getDirectionVectorUp() return vec3(0, 0, 1) end
  if o.xyzApi then
    function obj:getDirectionVectorXYZ() local f = basis() return f.x, f.y, f.z end
    function obj:getDirectionVectorUpXYZ() return 0, 0, 1 end
  end
  function obj:getGravity() return -g end
  function obj:getStaticFrictionCoef() return P.mu end
  function obj:getNodePosition(id)
    local w, side = nodeOf[id][1], nodeOf[id][2]
    local ang = wheelAngleRad(w)
    local ax, az = math.cos(ang), -math.sin(ang)
    return localToWorld(w.lx + side * 0.1 * ax, w.lz + side * 0.1 * az)
  end
  function obj:getNodeVelocityVector(id)
    local w = nodeOf[id][1]
    if w.isBroken then return vec3(math.random() * 80 - 40, math.random() * 80 - 40, math.random() * 20) end -- wheel flying away
    local n = o.velNoise and (math.random() - 0.5) * 2 * o.velNoise or 0
    return localToWorld(car.vx + car.r * w.lz + n, car.vy - car.r * w.lx)
  end

  local function axleForce(p, deltaRad, Fz, muK)
    local vlat, vlong = car.vx + car.r * p, car.vy
    local cs, sn = math.cos(deltaRad), math.sin(deltaRad)
    local longW = vlong * cs + vlat * sn
    local latW  = vlat * cs - vlong * sn
    local alpha = -math.atan2(latW, math.max(math.abs(longW), 0.5))
    local F = tyreFy(alpha, Fz, muK)
    return F * cs, alpha
  end
  function S.step(dt, accel)
    local dd = S.steerCmd - S.rack
    S.rack = S.rack + math.max(-P.rackRate * dt, math.min(P.rackRate * dt, dd))
    car.delta = inputToAngle(S.rack)
    local Fzf = P.m * g * P.b / (P.a + P.b)
    local Fzr = P.m * g * P.a / (P.a + P.b)
    if S.airborne then Fzf, Fzr = 0, 0 end
    local fd, rd = math.rad(car.delta), 0
    if o.rearSteer then fd, rd = 0, -math.rad(car.delta) end
    local Ff, af = axleForce(P.a, fd, Fzf, (o.frontMuK or 1) * (wl[1].isBroken and 0.5 or 1))
    local Fr, ar = axleForce(-P.b, rd, Fzr, P.rearMu)
    local ay = (Ff + Fr) / P.m
    car.vx = car.vx + (ay - car.r * car.vy) * dt
    car.r = car.r + ((Ff * P.a - Fr * P.b) / P.Iz) * dt
    car.vy = car.vy + (accel or 0) * dt
    car.psi = car.psi - car.r * dt
    sensors.gx2 = ay; sensors.gy2 = accel or 0
    for _, w in ipairs(wl) do w.downForceRaw = (w.lz > 0 and Fzf or Fzr) / 2; w.wheelSpeed = car.vy end
    return math.deg(af), math.deg(ar), ay
  end

  S.M = dofile(SCRIPT)
  S.M.onVehicleLoaded()
  function S.frame(dt, stick, accel)
    S.t = S.t + dt
    input.state.steering.val = stick
    electrics.values.steering_input = stick -- what BeamNG's own filter would have produced (unfiltered here)
    S.M.updateGFX(dt)
    local outv = electrics.values.steering_input
    if isnan(outv) or outv == nil then S.nan = true; outv = 0 end
    if math.abs(outv) > 1.0000001 then S.range = true end
    S.steerCmd = outv
    local af, ar, ay
    local n = math.max(1, math.floor(dt / (1 / 480) + 0.5))
    for i = 1, n do af, ar, ay = S.step(dt / n, accel) end
    if isnan(car.vx) or isnan(car.r) then S.nan = true end
    return af, ar, ay
  end
  function S.calibrate(dt, T) for i = 1, math.floor((T or 10) / (dt or 1 / 60)) do S.frame(dt or 1 / 60, 0, 0) end end
  function S.set(vx, r, vy) car.vx, car.r, car.vy = vx, r, vy; S.rack, S.steerCmd, car.delta = 0, 0, 0; S.M.onReset() end
  function S.run(T, stickFn, dt)
    dt = dt or 1 / 60
    local af, ar, ay, maxR = 0, 0, 0, 0
    local N = math.floor(T / dt)
    for i = 1, N do
      af, ar, ay = S.frame(dt, type(stickFn) == "number" and stickFn or stickFn(i * dt), 0)
      if i > N / 2 then maxR = math.max(maxR, math.abs(car.r)) end
    end
    return af, ar, ay, maxR
  end
  function S.state() return S.M.getState() end
  return S
end

local function flag(S) return (S.nan and " NAN!" or "") .. (S.range and " RANGE!" or "") end
local function lastMsg() for i = #MSGS, 1, -1 do if not MSGS[i]:match("^[IDW] ") then return MSGS[i] end end return "-" end
local function P(...) print(string.format(...)) end
local function try(name, f)
  local ok, err = pcall(f)
  if not ok then P("%-28s ERROR: %s", name, tostring(err)) end
end

local function slide(S, vx, r, vy, T)
  S.set(vx, r, vy)
  local peakBeta, e = 0, 0
  for i = 1, (T or 5) * 60 do
    S.frame(1 / 60, 0, 0)
    peakBeta = math.max(peakBeta, math.abs(math.deg(math.atan2(S.car.vx, math.abs(S.car.vy)))))
    e = e + S.car.r ^ 2 / 60
  end
  return peakBeta, e
end

try("A baseline", function()
  local S = newSim(); S.calibrate()
  S.set(0, 0, 25); local af, ar, ay = S.run(5, 1)
  P("A  full lock @25             af=%6.2f ay=%.2fg lock=%.1f%s", af, ay / g, S.state().lock, flag(S))
  local pb, e = slide(S, -4, 0.6, 20)
  P("A  slide, stick released     peak bodyslip=%.1f int r^2=%.3f final r=%.3f%s", pb, e, S.car.r, flag(S))
end)

try("A2 xyz api", function()
  local S = newSim({xyzApi = true}); S.calibrate()
  S.set(0, 0, 25); local af, ar, ay = S.run(5, 1)
  P("A2 full lock (XYZ api path)  af=%6.2f ay=%.2fg%s", af, ay / g, flag(S))
end)

try("B sign inverted", function()
  local S = newSim({signInv = true}); S.calibrate()
  S.set(0, 0, 25); local af, ar, ay = S.run(5, 1)
  P("B  INVERTED sign: full lock  af=%6.2f ay=%.2fg r=%.3f (stick +1 => left turn expected, |af|~7.6, r<0) sign=%s%s", af, ay / g, S.car.r, tostring(S.state().sign), flag(S))
  local pb, e = slide(S, -4, 0.6, 20)
  P("B  INVERTED sign: slide rel. peak bodyslip=%.1f int r^2=%.3f final r=%.3f (normal convention gives 13.6 / 0.130)%s", pb, e, S.car.r, flag(S))
end)

try("B2 sign inverted, no calib", function()
  for _, inv in ipairs({false, true}) do
    local S = newSim({signInv = inv, cfg = {calibrate = false}})
    S.set(0, 0, 25); S.run(3, function(t) return t < 1.5 and 0.4 or 0 end) -- drive a bit so the sign can be observed
    local sg = S.state().sign
    local pb, e = slide(S, -4, 0.6, 20)
    P("B2 calibrate=false, inverted=%-5s: detected sign=%s  slide rel. peak bodyslip=%.1f int r^2=%.3f%s", tostring(inv), tostring(sg), pb, e, flag(S))
  end
end)

try("C reverse", function()
  for _, variant in ipairs({"default", "aga"}) do
    local S = newSim({cfg = (variant == "aga") and {reverseDampingFix = false} or nil}); S.calibrate()
    S.set(0, 0, -8); local af, ar, ay = S.run(4, 0.15)
    local outS, rS = electrics.values.steering_input, S.car.r
    S.set(0, 0, -8); S.run(0.5, 0)
    S.car.r = 0.3
    local peak, e = 0, 0
    for i = 1, 240 do S.frame(1 / 60, 0, 0); peak = math.max(peak, math.abs(math.deg(math.atan2(S.car.vx, 8)))); e = e + S.car.r ^ 2 / 60 end
    P("C  reverse -8 m/s [%-7s] stick .15: out=%.3f r=%.3f (r<0: reversing with right lock yaws left) | hands-off yaw kick: peak bodyslip=%.2f int r^2=%.4f final r=%.4f%s",
      variant, outS, rS, peak, e, S.car.r, flag(S))
  end
end)

try("D broken wheel", function()
  local S = newSim(); S.calibrate()
  S.set(0, 0, 25); S.wl[1].isBroken = true
  local af, ar, ay = S.run(5, 1)
  P("D  broken FL, full lock @25  af=%6.2f ay=%.2fg out=%.3f%s", af, ay / g, electrics.values.steering_input, flag(S))
  S.wl[2].isBroken = true
  S.run(1, 1)
  P("D  both fronts broken        out=%.3f (passthrough expected = 1.000)%s", electrics.values.steering_input, flag(S))
end)

try("E airborne", function()
  local S = newSim(); S.calibrate()
  S.set(0, 0, 25); S.run(2, 0.6)
  S.airborne = true; local maxJump, prev = 0, electrics.values.steering_input
  for i = 1, 60 do S.frame(1 / 60, 0.6, 0); maxJump = math.max(maxJump, math.abs(electrics.values.steering_input - prev)); prev = electrics.values.steering_input end
  S.airborne = false
  for i = 1, 30 do S.frame(1 / 60, 0.6, 0); maxJump = math.max(maxJump, math.abs(electrics.values.steering_input - prev)); prev = electrics.values.steering_input end
  local af, ar, ay = S.run(3, 0.6)
  P("E  1 s airborne mid-corner   max per-frame output jump=%.3f, after landing af=%.2f ay=%.2fg targetSlip=%.2f%s", maxJump, af, ay / g, S.state().targetSlip, flag(S))
end)

try("F stick during calibration", function()
  local S = newSim()
  local dt = 1 / 60
  for k = 1, 5 do
    for i = 1, 50 do S.frame(dt, 0, 0) end   -- calibration starts
    for i = 1, 20 do S.frame(dt, 0.5, 0) end -- player wiggles the stick -> abort
  end
  S.calibrate(dt, 12)
  P("F  5 stick aborts then idle  lock=%.2f (true 33) curve=%s", S.state().lock, dumps(S.state().curve))
end)

try("G fps/slow hydro", function()
  for _, c in ipairs({{1 / 240, 0.5}, {1 / 30, 0.5}, {1 / 240, 3.0}, {1 / 60, 0.25}}) do
    local S = newSim({rackRate = c[2]}); S.calibrate(c[1], 25)
    local cv = S.state().curve
    local worst = 0
    local ins = S.state().curveIn or {0.0, 0.1, 0.2, 0.35, 0.5, 0.7, 1.0}
    for i = 1, #cv do if ins[i] then worst = math.max(worst, math.abs(cv[i] - ins[i] ^ 1.15)) end end
    P("G  calib @%3d fps rack %.2f/s lock=%.2f worst curve err=%.3f  (%s)", math.floor(1 / c[1] + 0.5), c[2], S.state().lock, worst, lastMsg())
  end
end)

try("H no F/R names", function()
  local S = newSim({names = {"wheel_a", "wheel_b", "wheel_c", "wheel_d"}}); S.calibrate()
  S.set(0, 0, 25); local af, ar, ay = S.run(5, 1)
  P("H  no F/R wheel names        af=%6.2f ay=%.2fg lock=%.1f (assist should work: af~7.6)%s", af, ay / g, S.state().lock, flag(S))
end)

try("I rear steer", function()
  local S = newSim({rearSteer = true}); S.calibrate()
  S.set(0, 0, 8); S.run(2, 0.5)
  P("I  rear-steer vehicle        out=%.3f (passthrough expected 0.500)  (%s)%s", electrics.values.steering_input, lastMsg(), flag(S))
end)

try("J ackermann/offset", function()
  local S = newSim({ackermann = 0.15, zeroOffsetDeg = 1.5}); S.calibrate()
  P("J  ackermann 15%% + 1.5deg toe offset: lock=%.2f (true mean 33.0) curve=%s", S.state().lock, dumps(S.state().curve))
end)

try("K slow hydros", function()
  for _, rr in ipairs({1.6, 0.8}) do
    local S = newSim({rackRate = rr}); S.calibrate()
    S.set(0, 0, 25)
    local maxAf = 0
    for i = 1, 300 do local af = S.frame(1 / 60, 1, 0); maxAf = math.max(maxAf, math.abs(af)) end
    local af, ar, ay = S.run(1, 1)
    local pb, e = slide(S, -4, 0.6, 20)
    P("K  rack %.1f/s: full lock af=%.2f (max %.2f) ay=%.2fg | slide released: peak bodyslip=%.1f int r^2=%.3f final r=%.3f%s", rr, af, maxAf, ay / g, pb, e, S.car.r, flag(S))
  end
end)

try("L noise", function()
  local S = newSim({velNoise = 0.15}); S.calibrate()
  S.set(0, 0, 25)
  local acc, prev, n = 0, nil, 0
  for i = 1, 300 do
    S.frame(1 / 60, 0.5, 0)
    local o2 = electrics.values.steering_input
    if i > 120 then if prev then acc = acc + math.abs(o2 - prev); n = n + 1 end; prev = o2 end
  end
  P("L  node velocity noise +-0.15 m/s: mean |d out| per frame=%.4f%s", acc / n, flag(S))
end)

try("M reset/filters", function()
  local S = newSim(); S.calibrate()
  local lock0 = S.state().lock
  S.set(0, 0, 25); S.run(1, 1)
  input.state.steering.filter = FILTER_DIRECT
  S.frame(1 / 60, 0.77, 0)
  local direct = electrics.values.steering_input
  input.state.steering.filter = FILTER_KBD
  S.frame(1 / 60, 0.66, 0)
  local kbd = electrics.values.steering_input
  playerInfo.anyPlayerSeated = false; input.state.steering.filter = FILTER_PAD
  S.frame(1 / 60, 0.55, 0)
  local unseated = electrics.values.steering_input
  playerInfo.anyPlayerSeated = true
  S.frame(0, 0.44, 0); local paused = electrics.values.steering_input
  S.frame(0.5, 1, 0) -- huge hitch
  P("M  wheel(direct)=%.2f kbd=%.2f unseated=%.2f paused(dt=0)=%.2f (all untouched: .77 .66 .55 .44) lock kept after reset=%s%s",
    direct, kbd, unseated, paused, tostring(S.state().lock == lock0), flag(S))
end)

-- oversteery car (rear grip 92% of front): without correct countersteer a yaw kick ends in a spin
try("N oversteery", function()
  for _, c in ipairs({{"assist OFF", {cfg = {enabled = false}}}, {"assist ON", {}}, {"ON, inverted sign conv.", {signInv = true}},
                      {"ON, inverted, calibrate=false", {signInv = true, cfg = {calibrate = false}}}}) do
    local o = c[2]; o.rearMu = 0.92
    local S = newSim(o); S.calibrate()
    S.set(0, 0, 15); S.run(2, function(t) return t < 1.2 and 0.3 or 0 end) -- gentle wiggle (lets passive sign detection work)
    local pb, e = slide(S, -3, 0.5, 22, 6)
    P("N  oversteery car, yaw kick, stick released [%-30s] peak bodyslip=%5.1f final r=%.3f %s%s", c[1], pb, S.car.r, pb > 45 and "SPIN" or "caught", flag(S))
  end
end)

try("O filters at spawn", function()
  local S = newSim({filter = FILTER_KBD}); S.calibrate()
  S.frame(1 / 60, 0.3, 0)
  local k = electrics.values.steering_input
  local S2 = newSim({filter = FILTER_DIRECT}); 
  local touched = false
  for i = 1, 600 do S2.frame(1 / 60, 0, 0); if electrics.values.steering_input ~= 0 then touched = true end end
  P("O  spawn with kbd filter: calibrated=%s, kbd steering untouched=%s | spawn with wheel (direct): calibrated=%s, steering ever overridden=%s",
    tostring(S.state().calibrated), tostring(k == 0.3), tostring(S2.state().calibrated), tostring(touched))
end)

try("P throttle/roll during calibration", function()
  local S = newSim()
  electrics.values.throttle_input = 1
  local touched = false
  for i = 1, 300 do S.frame(1 / 60, 0, 0); if electrics.values.steering_input ~= 0 then touched = true end end
  electrics.values.throttle_input = 0
  P("P  throttle held at standstill: sweep started=%s (expected false)", tostring(touched))
end)

try("Q fps + smoothing option", function()
  for _, c in ipairs({{1 / 30, nil}, {1 / 144, nil}, {1 / 60, {velocitySmoothing = 0.03}}}) do
    local S = newSim({velNoise = c[2] and 0.15 or nil, cfg = c[2], rearMu = 1.12}); S.calibrate(c[1])
    S.set(0, 0, 25); local af, ar, ay = S.run(5, 1, c[1])
    local S2 = newSim({rearMu = 0.92, cfg = c[2]}); S2.calibrate(c[1])
    S2.set(-3, 0.5, 22)
    local pb = 0
    for i = 1, math.floor(6 / c[1]) do S2.frame(c[1], 0, 0); pb = math.max(pb, math.abs(math.deg(math.atan2(S2.car.vx, S2.car.vy)))) end
    P("Q  %3d fps%s: full lock af=%.2f ay=%.2fg | oversteery slide released peak bodyslip=%.1f final r=%.3f%s%s",
      math.floor(1 / c[1] + 0.5), c[2] and " velocitySmoothing=0.03 (+noise)" or "", af, ay / g, pb, S2.car.r, flag(S), flag(S2))
  end
end)
