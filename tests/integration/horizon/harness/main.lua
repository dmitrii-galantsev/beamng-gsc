-- Mock BeamNG game-engine Lua + a scripted car to exercise the compiled horizon.lua end to end.
-- Prints one line per scenario phase; scripts/integration.mjs compares the output with expected/harness.txt.
local SCRIPT = ...
local sin, cos, atan2, sqrt, abs, pi = math.sin, math.cos, math.atan2, math.sqrt, math.abs, math.pi

local V = {} V.__index = V
function vec3(x, y, z) return setmetatable({x = x or 0, y = y or 0, z = z or 0}, V) end
function V:set(a, b, c) self.x, self.y, self.z = a, b, c end
function quatFromDir(d, u) return {d = d, u = u} end
local STORE = {}
settings = {getValue = function(k, d) local v = STORE[k] if v == nil then return d end return v end}
MoveManager = {yawLeft = 0, yawRight = 0, pitchUp = 0, pitchDown = 0, zoomIn = 0, zoomOut = 0}
local LIVE, COLLISIONS = nil, 0
guihooks = {trigger = function(name, t) if name == 'hzcLive' then LIVE = t end end}
package.preload['core/cameraModes/collision'] = function()
  return function() return {init = function() end, update = function() COLLISIONS = COLLISIONS + 1 end} end
end

local car = {x = 0, y = 0, z = 0, yaw = 0, v = 0}
be = {}
function be:getObjectOOBBCenterXYZ() return car.x + sin(car.yaw) * 0.2, car.y + cos(car.yaw) * 0.2, car.z + 0.5 end
local veh = {}
function veh:getID() return 1 end
function veh:getSpawnWorldOOBBRearPoint() return vec3(car.x - sin(car.yaw) * 2.1, car.y - cos(car.yaw) * 2.1, car.z + 0.5) end
function veh:getNodePosition(n)
  local fx, fy = sin(car.yaw), cos(car.yaw)
  if n == 1 then return vec3(0, 0, 0) elseif n == 2 then return vec3(-fy * 0.5, fx * 0.5, 0) end
  return vec3(-fx, -fy, 0)
end

local cam = assert(loadfile(SCRIPT))()()
assert(type(cam.update) == 'function' and cam.disabledByDefault == false, 'constructor contract')
cam:setRefNodes(1, 2, 3)
local data = {dt = 1 / 60, veh = veh, pos = vec3(), vel = vec3(), prevVel = vec3(), res = {pos = vec3()}}
local t, worstOff = 0, 0

local function wrap(a) return (a + pi) % (2 * pi) - pi end
local function phase(name, dur, acc, yawRate, slipDeg, bump, dt)
  dt = dt or 1 / 60
  local row
  for _ = 1, math.floor(dur / dt + 0.5) do
    car.v = math.max(0, car.v + acc * dt)
    car.yaw = car.yaw + yawRate * dt
    local tr = car.yaw + math.rad(slipDeg or 0)
    local vx, vy = car.v * sin(tr), car.v * cos(tr)
    car.x, car.y = car.x + vx * dt, car.y + vy * dt
    local z = car.z + (bump and bump * sin(t * 25) or 0)
    data.dt = dt
    data.prevVel = vec3(data.vel.x, data.vel.y, data.vel.z)
    data.vel = vec3(vx, vy, 0)
    data.pos = vec3(car.x, car.y, z)
    assert(cam:update(data) == true, name .. ': update returned false')
    t = t + dt
    local r = data.res
    for _, q in ipairs({r.pos.x, r.pos.y, r.pos.z, r.rot.d.x, r.rot.d.y, r.rot.d.z, r.rot.u.x, r.rot.u.y, r.fov}) do
      assert(q == q and abs(q) < 1e7, name .. ': bad number')
    end
    local view = atan2(r.rot.d.x, r.rot.d.y)
    local off = math.deg(wrap(atan2(car.x - r.pos.x, car.y - r.pos.y) - view))
    local dist = sqrt((car.x - r.pos.x) ^ 2 + (car.y - r.pos.y) ^ 2)
    worstOff = math.max(worstOff, abs(off))
    row = string.format('%-26s v=%3.0f km/h  dist=%5.2f  camH=%5.2f  fov=%5.1f  view-heading=%7.1f  carOff=%5.1f',
      name, car.v * 3.6, dist, r.pos.z - z, r.fov, math.deg(wrap(view - car.yaw)), off)
    assert(dist > 2 and dist < 20, name .. ': distance out of range')
    assert(r.fov >= 20 and r.fov <= 110, name .. ': fov out of range')
  end
  print(row)
end

phase('standstill', 1, 0, 0)
phase('launch 0.8g', 3, 8, 0)
phase('accelerate', 12, 4.3, 0)
phase('cruise', 3, 0, 0)
phase('fast sweeper', 3, 0, 0.25)
phase('hard brake 1.2g', 3, -12, 0)
phase('hairpin', 2.5, -3, 1.2)
phase('drift 30 deg', 3, 2, 0.6, -30)
phase('straighten', 2, 0, 0)
phase('bumps', 2, 0, 0, 0, 0.15)
assert(worstOff < 12, 'car left the middle of the frame: ' .. worstOff)
print(string.format('car stayed within %.1f deg of the aim direction', worstOff))

-- orbit stick: rate control, stays, eases back only while driving
MoveManager.yawRight = 1 phase('stick right 0.5 s', 0.5, 0, 0) MoveManager.yawRight = 0
phase('released 1 s (holds)', 1, 0, 0)
phase('released 4 s (recentred)', 3, 0, 0)
car.v = 0 data.vel = vec3()
MoveManager.yawLeft = 1 phase('parked, stick left 0.5 s', 0.5, 0, 0) MoveManager.yawLeft = 0
phase('parked, released 5 s', 5, 0, 0)
data.lookBack = true phase('look back', 0.2, 0, 0) data.lookBack = false
phase('look back released', 0.2, 0, 0)

-- settings are read through the settings API and clamped
STORE.hzc_dist, STORE.hzc_fov, STORE.hzc_shake = 2, 'junk', 99
cam:onSettingsChanged()
cam:onVehicleSwitched()
phase('dist 2x, bad fov ignored', 1, 0, 0)
STORE = {} cam:onSettingsChanged()

-- live telemetry only while asked for
assert(LIVE == nil, 'live data sent without being asked')
rawset(_G, 'hzcLiveT', 1) phase('live on', 0.5, 0, 0)
local keys = {} for k in pairs(LIVE) do keys[#keys + 1] = k end table.sort(keys)
print('live: ' .. table.concat(keys, ' '))

-- odd frames
phase('30 fps', 1, 3, 0.3, 0, nil, 1 / 30)
phase('240 fps', 0.5, 0, 0.3, 0, nil, 1 / 240)
data.dt = 0 assert(cam:update(data) == true) data.dt = 5 assert(cam:update(data) == true)
cam:reset() assert(cam:update(data) == true)
print('collision helper calls: ' .. (COLLISIONS > 0 and 'yes' or 'no'))
print('OK')
