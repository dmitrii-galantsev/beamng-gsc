-- AGA Steering for BeamNG.drive
-- Port of the steering core of "Advanced Gamepad Assist" for Assetto Corsa
-- Original: https://github.com/adam10603/AC-Advanced-Gamepad-Assist  (MIT License, Copyright (c) 2023 Adam D.)
-- BeamNG port: same MIT terms.
--
-- What it does (gamepad only by default):
--   * smooths raw stick input with a speed-aware rate
--   * limits the commanded front wheel angle so the front tyres sit near their peak slip angle
--     (no more plowing understeer from full-lock stick inputs)
--   * adds a "self-steer" force that follows the rear axle's direction of travel + yaw damping,
--     which emulates a force-feedback wheel catching slides for you when you let go of the stick
--   * relaxes the limit when you countersteer so you can still catch and hold drifts
--
-- It runs after BeamNG's own input filtering and overwrites the final steering value,
-- so BeamNG's built-in gamepad assists are bypassed while this is active.
--
-- Conventions used internally: every lateral quantity is "positive = to the RIGHT of the car"
-- (AC's local frame is x = left, so lateral angles are sign-flipped relative to the original source).
-- The sign of BeamNG's steering_input is NOT assumed: it is measured (calibration sweep, or passively
-- while driving) and the assist stays in plain pass-through until it is known.
--
-- Config: <userfolder>/settings/agaSteering.json  (re-read on every vehicle reset / spawn)
--
-- GENERATED FILE - do not edit. Source: TypeScript in aga-src/src, compiled with TypeScriptToLua (npm run build).
-- NOTE v3.3/v3.4: rally mode, the Off/Grip/Rally mode API and the gauge telemetry were patched into this Lua
-- directly (TS source was not available).
-- Layout: a tiny module loader, then one section per source module (lualib_bundle = TypeScriptToLua runtime
-- helpers, mathx, smooth, config, calibration, learn, steering, agaSteering = BeamNG glue and hooks).

local ____modules = {}
local ____moduleCache = {}
local ____originalRequire = require
local function require(file, ...)
    if ____moduleCache[file] then
        return ____moduleCache[file].value
    end
    if ____modules[file] then
        local module = ____modules[file]
        local value = nil
        if (select("#", ...) > 0) then value = module(...) else value = module(file) end
        ____moduleCache[file] = { value = value }
        return value
    else
        if ____originalRequire then
            return ____originalRequire(file)
        else
            error("module '" .. file .. "' not found")
        end
    end
end
____modules = {
["lualib_bundle"] = function(...) 
local function __TS__TypeOf(value)
    local luaType = type(value)
    if luaType == "table" then
        return "object"
    elseif luaType == "nil" then
        return "undefined"
    else
        return luaType
    end
end

local function __TS__Class(self)
    local c = {prototype = {}}
    c.prototype.__index = c.prototype
    c.prototype.constructor = c
    return c
end

local function __TS__New(target, ...)
    local instance = setmetatable({}, target.prototype)
    instance:____constructor(...)
    return instance
end

return {
  __TS__TypeOf = __TS__TypeOf,
  __TS__Class = __TS__Class,
  __TS__New = __TS__New
}
 end,
["mathx"] = function(...) 
local ____exports = {}
local abs = math.abs
local min = math.min
local max = math.max
local huge = math.huge
local function clamp(x, a, b)
    return x < a and a or (x > b and b or x)
end
local function clamp01(x)
    return clamp(x, 0, 1)
end
local function sgn(x)
    return x > 0 and 1 or (x < 0 and -1 or 0)
end
local function lerp(a, b, t)
    return a + (b - a) * t
end
--- Saturated inverse lerp: 0 at a, 1 at b, clamped; 0 for a degenerate range.
local function lerpInvSat(x, a, b)
    if abs(b - a) < 1e-12 then
        return 0
    end
    return clamp01((x - a) / (b - a))
end
local function inverseLerp(a, b, x)
    local d = b - a
    return abs(d) > 1e-60 and (x - a) / d or 0
end
--- Replaces nil / NaN / +-inf by `alt` (default 0).
local function nanGuard(x, alt)
    if x == nil or x ~= x or x == huge or x == -huge then
        return alt or 0
    end
    return x
end
local function signedPow(x, y)
    return sgn(x) * abs(x) ^ y
end
--- Clamp with quadratic easing into both limits; `easingWindow` is a fraction of (maxVal - minVal).
local function clampEased(val, minVal, maxVal, easingWindow)
    local windowScaled = easingWindow * (maxVal - minVal)
    local halfWindowScaled = windowScaled * 0.5
    local minLow = minVal - halfWindowScaled
    local minHigh = minVal + halfWindowScaled
    local maxLow = maxVal - halfWindowScaled
    local maxHigh = maxVal + halfWindowScaled
    if val < minLow then
        return minVal
    end
    if val > maxHigh then
        return maxVal
    end
    if val < minHigh then
        local t = (val - minLow) / windowScaled
        return minVal + t * t * halfWindowScaled
    end
    if val > maxLow then
        local t = (val - maxLow - windowScaled) / windowScaled
        return maxVal - t * t * halfWindowScaled
    end
    return val
end
local function inverseLerpClampedEased(from, to, val, outMin, outMax, win)
    return clampEased(
        inverseLerp(from, to, val),
        outMin,
        outMax,
        win
    )
end
--- One-pole low-pass kept in `state[key]`; the first sample initialises the state.
local function lowpass(state, key, val, dt, tau)
    local s = state[key]
    if s == nil then
        state[key] = val
        return val
    end
    s = s + (val - s) * min(1, dt / tau)
    state[key] = s
    return s
end
--- Odd-symmetric piecewise-linear interpolation of the table (xs -> ys) at |x|, sign restored.
-- xs must be ascending and start at 0; saturates at the last point.
local function interp(xs, ys, x)
    local s = sgn(x)
    x = abs(x)
    local n = #xs
    if x >= xs[n] then
        return s * ys[#ys]
    end
    do
        local i = 1
        while i < n do
            if x <= xs[i + 1] then
                local t = (x - xs[i]) / max(xs[i + 1] - xs[i], 1e-9)
                return s * lerp(ys[i], ys[i + 1], t)
            end
            i = i + 1
        end
    end
    return s * ys[#ys]
end
____exports.clamp = clamp
____exports.clamp01 = clamp01
____exports.sgn = sgn
____exports.lerp = lerp
____exports.lerpInvSat = lerpInvSat
____exports.inverseLerp = inverseLerp
____exports.nanGuard = nanGuard
____exports.signedPow = signedPow
____exports.clampEased = clampEased
____exports.inverseLerpClampedEased = inverseLerpClampedEased
____exports.lowpass = lowpass
____exports.interp = interp
return ____exports
 end,
["calibration"] = function(...) 
local ____exports = {}
local ____mathx = require("mathx")
local clamp = ____mathx.clamp
local interp = ____mathx.interp
local nanGuard = ____mathx.nanGuard
local sgn = ____mathx.sgn
local abs = math.abs
local min = math.min
--- steering_input magnitudes visited by the standstill sweep.
____exports.calibInputs = {
    0.1,
    0.2,
    0.35,
    0.5,
    0.7,
    1
}
function ____exports.newSteerModel()
    return {
        lockDeg = 35,
        curveIn = {0, 1},
        curveOut = {0, 1},
        sign = 0,
        zeroDeg = 0,
        calibrated = false,
        unsupported = false,
        signRamp = 0
    }
end
--- samples[i] = signed front wheel angle (zero offset removed) at steering_input = calibInputs[i].
-- On "ok" the model's lock, curve and sign are replaced; otherwise the model is left untouched.
function ____exports.finishCalibration(steer, samples, rearDelta)
    local lockSigned = samples[#____exports.calibInputs]
    if lockSigned == nil or lockSigned ~= lockSigned then
        return "bad"
    end
    local lockDeg = abs(lockSigned)
    if lockDeg < 3 then
        return abs(rearDelta or 0) > 3 and "rearsteer" or "nosteer"
    end
    if lockDeg > 89 then
        return "bad"
    end
    local s = sgn(lockSigned)
    local ins = {0}
    local outs = {0}
    local prev = 0
    do
        local i = 0
        while i < #____exports.calibInputs do
            local n = clamp(
                nanGuard(samples[i + 1]) * s / lockDeg,
                0,
                1
            )
            if n <= prev + 0.0001 then
                n = prev + 0.0001
            end
            ins[#ins + 1] = ____exports.calibInputs[i + 1]
            outs[#outs + 1] = min(n, 1)
            prev = n
            i = i + 1
        end
    end
    outs[#outs] = 1
    steer.curveIn = ins
    steer.curveOut = outs
    steer.lockDeg = lockDeg
    steer.sign = s
    steer.calibrated = true
    return "ok"
end
--- Steering curve: steering_input (-1..1) -> normalized wheel angle with the same sign.
function ____exports.inputToNormalizedSteering(steer, u)
    return interp(steer.curveIn, steer.curveOut, u)
end
--- Normalized wheel angle (magnitude) at which an interrupted sweep left the wheels: the sweep holds
-- steering_input = calibInputs[idx - 1] (idx 0 = still measuring the centre), and the smoothers that take over
-- work in normalized wheel angle, not in steering_input.
function ____exports.sweepAbortSeed(steer, idx)
    return ____exports.inputToNormalizedSteering(steer, ____exports.calibInputs[idx] or 0)
end
--- Inverse steering curve: normalized wheel angle (-1..1) -> |steering_input| with the same sign.
function ____exports.normalizedSteeringToInput(steer, a)
    return interp(steer.curveOut, steer.curveIn, a)
end
return ____exports
 end,
["config"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__TypeOf = ____lualib.__TS__TypeOf
local ____exports = {}
local ____mathx = require("mathx")
local clamp = ____mathx.clamp
--- Same as AGA factory defaults.
____exports.defaults = {
    enabled = true,
    applyToKeyboard = false,
    steeringRate = 0.5,
    filterSetting = 0.5,
    rally = false,
    rallyKnee = 0.65,
    rallyExtraDeg = 18,
    useFilter = true,
    targetSlip = 0.95,
    maxSelfSteerAngle = 90,
    rateIncreaseWithSpeed = 0,
    selfSteerResponse = 0.37,
    dampingStrength = 0.37,
    countersteerResponse = 0.2,
    maxDynamicLimitReduction = 5,
    peakSlipDeg = 0,
    learnPeakSlip = true,
    calibrate = true,
    reverseDampingFix = true,
    velocitySmoothing = 0,
    debug = false
}
--- Allowed ranges for numeric keys (anything outside is clamped).
____exports.ranges = {
    steeringRate = {0.01, 1},
    filterSetting = {0, 1},
    targetSlip = {0.5, 1.5},
    maxSelfSteerAngle = {0, 90},
    rateIncreaseWithSpeed = {-0.5, 0.5},
    selfSteerResponse = {0, 1},
    dampingStrength = {0, 1},
    countersteerResponse = {0, 1},
    maxDynamicLimitReduction = {0, 10},
    peakSlipDeg = {0, 20},
    rallyKnee = {0.4, 0.9},
    rallyExtraDeg = {0, 60},
    velocitySmoothing = {0, 0.2}
}
--- Rebuilds `cfg` IN PLACE (getState() hands out this very table) from defaults + `data` (the parsed JSON, or
-- anything else: unknown keys, wrong types and NaN are ignored), clamps the numeric keys, derives the advanced
-- parameters when useFilter is set, and finally applies the runtime enable override.
function ____exports.applyConfig(cfg, data, enabledOverride)
    local out = cfg
    local defs = ____exports.defaults
    for k in pairs(defs) do
        out[k] = defs[k]
    end
    if type(data) == "table" and data ~= nil then
        local src = data
        for k in pairs(src) do
            local val = src[k]
            local def = defs[k]
            if def ~= nil and type(def) == "number" and type(val) == "string" then
                val = tonumber(val)
            end
            if def ~= nil and __TS__TypeOf(val) == __TS__TypeOf(def) and val == val then
                out[k] = val
            end
        end
    end
    local nums = cfg
    local rs = ____exports.ranges
    for k in pairs(rs) do
        local r = rs[k]
        nums[k] = clamp(nums[k], r[1], r[2])
    end
    if cfg.useFilter then
        local f = cfg.filterSetting
        cfg.rateIncreaseWithSpeed = (1 - f) * 0.2 - 0.1
        cfg.selfSteerResponse = f * 0.5 + 0.12
        cfg.dampingStrength = cfg.selfSteerResponse
        cfg.maxSelfSteerAngle = 90
        cfg.maxDynamicLimitReduction = 3 * f + 3.5
        cfg.countersteerResponse = (1 - f) * 0.2 + 0.1
        cfg.targetSlip = 0.95 - (f - 0.5) * 0.04
    end
    if enabledOverride ~= nil then
        cfg.enabled = enabledOverride
    end
end
return ____exports
 end,
["smooth"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__Class = ____lualib.__TS__Class
local ____exports = {}
local ____mathx = require("mathx")
local sgn = ____mathx.sgn
local abs = math.abs
local min = math.min
____exports.Smooth = __TS__Class()
local Smooth = ____exports.Smooth
Smooth.name = "Smooth"
function Smooth.prototype.____constructor(self, rate, linearity, minV, maxV, start)
    self.rate = rate
    self.linearity = linearity
    self.range = maxV - minV
    self.state = start or 0
    self.start = start or 0
end
function Smooth.prototype.get(self, val, dt, rateOverride)
    local r = rateOverride or self.rate
    local linSq = self.linearity * self.linearity
    local rate = r / (1 - 1 / (linSq + 1 / 0.75)) * 0.5
    local diffAbsN = abs((val - self.state) / self.range)
    local adjusted = (diffAbsN * (1 - linSq) + linSq) * rate
    self.state = self.state + sgn(val - self.state) * min(diffAbsN, dt * adjusted) * self.range
    return self.state
end
function Smooth.prototype.getMult(self, val, dt, mult)
    return self:get(val, dt, self.rate * mult)
end
function Smooth.prototype.reset(self)
    self.state = self.start
end
return ____exports
 end,
["learn"] = function(...) 
local ____exports = {}
local ____mathx = require("mathx")
local clamp = ____mathx.clamp
local clamp01 = ____mathx.clamp01
local lerp = ____mathx.lerp
local lowpass = ____mathx.lowpass
local nanGuard = ____mathx.nanGuard
local sgn = ____mathx.sgn
local abs = math.abs
local min = math.min
local max = math.max
local deg = math.deg
local rad = math.rad
local huge = math.huge
function ____exports.newLearnState()
    return {
        mF = nil,
        mFn = 0,
        C0 = nil,
        muMax = nil,
        muPrior = 1,
        n = 0,
        lastFz = nil,
        default = 8,
        cfgPeak = nil
    }
end
function ____exports.newFrontAxleSample()
    return {
        FzF = 0,
        minFz = huge,
        sameMat = true,
        slipRatioOk = true,
        nFront = 0
    }
end
--- Front vertical load (handles aero + load transfer), surface and wheel-slip checks. Fills `out`.
function ____exports.sampleFrontAxle(out, frontWheels, dd, isTarmac)
    local FzF = 0
    local minFz = huge
    local sameMat = true
    local firstMat = nil
    local slipRatioOk = true
    local nFront = 0
    do
        local i = 0
        while i < #frontWheels do
            local wd = frontWheels[i + 1]
            if not wd.isBroken then
                local fz = nanGuard(wd.downForceRaw)
                FzF = FzF + fz
                minFz = min(minFz, fz)
                nFront = nFront + 1
                local mat = wd.contactMaterialID1
                if mat == 4 then
                    mat = wd.contactMaterialID2
                end
                firstMat = firstMat or mat
                if mat ~= firstMat or not isTarmac(mat) then
                    sameMat = false
                end
                local ws = wd.wheelSpeed
                if ws ~= nil and dd.fAxleHVelLen > 1 and abs(ws - dd.fVelFwd) / dd.fAxleHVelLen > 0.1 then
                    slipRatioOk = false
                end
            end
            i = i + 1
        end
    end
    if nFront < #frontWheels then
        sameMat = false
    end
    out.FzF = FzF
    out.minFz = minFz
    out.sameMat = sameMat
    out.slipRatioOk = slipRatioOk
    out.nFront = nFront
end
--- Peak slip angle estimate in deg from the learned stiffness and friction, limited to 4..14 deg.
function ____exports.peakSlipEstimateDeg(muMax, C0)
    return deg(clamp(
        2.4 * muMax / max(C0, 0.001),
        rad(4),
        rad(14)
    ))
end
--- One estimator step. Updates `learn`, `filt` and the target slip held in `targetSlip.state`.
-- 
-- @param nFrontWheels number of front wheels the car has (intact or not)
-- @param g gravity magnitude, m/s^2
-- @param ay |lateral acceleration|, m/s^2
-- @param ax |longitudinal acceleration|, m/s^2
function ____exports.updateLearning(learn, filt, targetSlip, dd, axle, nFrontWheels, g, ay, ax, dt)
    local FzF = axle.FzF
    local lpState = filt.lp
    if dd.hVelLen < 3 and ax < 0.5 and ay < 0.5 then
        filt.stillT = filt.stillT + dt
    else
        filt.stillT = 0
    end
    if filt.stillT > 0.5 and FzF > 0 and axle.nFront == nFrontWheels then
        learn.mFn = min(learn.mFn + 1, 600)
        learn.mF = (learn.mF or FzF / g) + (FzF / g - (learn.mF or FzF / g)) / learn.mFn
    end
    local mF = learn.mF
    if mF == nil or FzF <= 0 then
        learn.why = 1
        return
    end
    local FzS = lowpass(
        lpState,
        "fz",
        FzF,
        dt,
        0.03
    )
    local ayS = lowpass(
        lpState,
        "ay",
        ay,
        dt,
        0.03
    )
    local alpha = lowpass(
        lpState,
        "al",
        abs(rad(dd.frontSlipDeg)),
        dt,
        0.03
    )
    local yawA = (dd.yawRateRight - (lpState.lastYaw or dd.yawRateRight)) / dt
    lpState.lastYaw = dd.yawRateRight
    yawA = lowpass(
        lpState,
        "yawA",
        yawA,
        dt,
        0.03
    )
    local lastFz = learn.lastFz
    local kerb = lastFz ~= nil and lastFz > 0 and abs(FzF - lastFz) / lastFz > 0.3 * (dt / 0.1)
    learn.lastFz = FzF
    local staticPerWheel = mF * g / max(nFrontWheels, 1)
    local turningSame = sgn(dd.frontSlipDeg) == sgn(dd.yawRateRight)
    local notDrifting = abs(dd.rAxleVelAngle) < abs(dd.frontSlipDeg)
    local ayKin = abs(dd.yawRateRight) * dd.hVelLen
    local accelOk = abs(ayS - ayKin) < 0.45 * max(ayS, ayKin) + 0.6
    local gate = dd.hVelLen > 8 and dd.fVelFwd > 0 and dd.rVelFwd > 0 and axle.slipRatioOk and ax < 3 and abs(yawA) < 1.2 and axle.minFz > 0.25 * staticPerWheel and axle.sameMat and turningSame and notDrifting and not kerb and accelOk
    local why = 0
    if not (dd.hVelLen > 8) then
        why = why + 2
    end
    if not (dd.fVelFwd > 0 and dd.rVelFwd > 0) then
        why = why + 4
    end
    if not axle.slipRatioOk then
        why = why + 8
    end
    if not (ax < 3) then
        why = why + 16
    end
    if not (abs(yawA) < 1.2) then
        why = why + 32
    end
    if not (axle.minFz > 0.25 * staticPerWheel) then
        why = why + 64
    end
    if not axle.sameMat then
        why = why + 128
    end
    if not turningSame then
        why = why + 256
    end
    if not notDrifting then
        why = why + 512
    end
    if kerb then
        why = why + 1024
    end
    if not accelOk then
        why = why + 2048
    end
    local dbg = learn.dbg
    if dbg == nil then
        dbg = {ayS = 0, ayKin = 0, alphaDeg = 0}
        learn.dbg = dbg
    end
    dbg.ayS = ayS
    dbg.ayKin = ayKin
    dbg.alphaDeg = deg(alpha)
    local C0 = learn.C0
    local muMax = learn.muMax
    if gate then
        local muF = mF * ayS / FzS
        dbg.muF = muF
        if not (alpha > rad(0.4) and alpha < rad(0.6 * targetSlip.state)) then
            why = why + 4096
        end
        if not (muF < 0.6 * muMax) then
            why = why + 8192
        end
        if alpha > rad(0.4) and alpha < rad(0.6 * targetSlip.state) and muF < 0.6 * muMax then
            C0 = C0 + (muF / alpha - C0) * min(1, dt / 2)
            learn.C0 = C0
            learn.n = min(learn.n + dt * 60, 600)
            learn.dirty = true
        end
        if muF > muMax then
            muMax = muMax + (muF - muMax) * min(1, dt / 0.3)
        else
            muMax = muMax + (learn.muPrior - muMax) * min(1, dt / 60)
        end
        muMax = clamp(muMax, learn.muPrior * 0.8, 2.5)
        learn.muMax = muMax
    end
    learn.why = why
    local est = ____exports.peakSlipEstimateDeg(muMax, C0)
    local target = lerp(
        learn.default,
        est,
        clamp01(learn.n / 300)
    )
    local cur = targetSlip.state
    targetSlip.state = cur + clamp(target - cur, -1 * dt, 1 * dt)
end
return ____exports
 end,
["steering"] = function(...) 
local ____exports = {}
local ____mathx = require("mathx")
local clamp = ____mathx.clamp
local clamp01 = ____mathx.clamp01
local clampEased = ____mathx.clampEased
local inverseLerpClampedEased = ____mathx.inverseLerpClampedEased
local lerp = ____mathx.lerp
local lerpInvSat = ____mathx.lerpInvSat
local nanGuard = ____mathx.nanGuard
local sgn = ____mathx.sgn
local signedPow = ____mathx.signedPow
local abs = math.abs
local min = math.min
local max = math.max
local sqrt = math.sqrt
local atan2 = math.atan2
local deg = math.deg
local rad = math.rad
local sin = math.sin
local log10 = math.log10
function ____exports.newFrameData()
    return {
        wheelbase = 0,
        wheelbaseFactor = 0,
        fVelRight = 0,
        fVelFwd = 0,
        rVelRight = 0,
        rVelFwd = 0,
        midVelFwd = 0,
        hVelLen = 0,
        fAxleHVelLen = 0,
        travelDirection = 0,
        yawRateRight = 0,
        frontGrounded = 0,
        rawSteerAngle = 0,
        rearSteerAngle = 0,
        steerAngle = 0,
        fAxleVelAngle = 0,
        rAxleVelAngle = 0,
        frontSlipDeg = 0
    }
end
--- Derives the kinematic quantities from the axle velocities (body frame: right / forward, m/s) and the
-- measured wheel angles (deg). Does not touch frontGrounded or the dbg* fields.
function ____exports.fillFrameData(d, fvx, fvz, rvx, rvz, wheelbase, frontAngle, rearAngle, zeroDeg)
    d.wheelbase = wheelbase
    d.wheelbaseFactor = wheelbase / 2.5
    d.fVelRight = fvx
    d.fVelFwd = fvz
    d.rVelRight = rvx
    d.rVelFwd = rvz
    local mvx = (fvx + rvx) * 0.5
    local mvz = (fvz + rvz) * 0.5
    d.midVelFwd = mvz
    d.hVelLen = sqrt(mvx * mvx + mvz * mvz)
    d.fAxleHVelLen = sqrt(fvx * fvx + fvz * fvz)
    d.travelDirection = d.hVelLen > 0.5 and nanGuard(deg(atan2(mvx, mvz))) or 0
    d.yawRateRight = (fvx - rvx) / wheelbase
    d.rawSteerAngle = frontAngle
    d.rearSteerAngle = rearAngle
    d.steerAngle = frontAngle - zeroDeg
    d.fAxleVelAngle = nanGuard(deg(atan2(
        fvx,
        abs(fvz)
    )))
    d.rAxleVelAngle = nanGuard(deg(atan2(
        rvx,
        abs(rvz)
    )))
    d.frontSlipDeg = d.steerAngle - d.fAxleVelAngle
end
---
-- @param speed total horizontal speed in m/s. (The original AGA names this parameter "fwdVelClamped" but passes
-- vData.localHVelLen, i.e. the horizontal speed, so that is what is used here too.)
function ____exports.calcSteeringRateMult(cfg, speed, lockDeg)
    if cfg.rally then
        return 1
    end
    local speedAdjustedRate = lockDeg / min(
        65 / (max(speed, 8) - 7.3) + 3.5,
        lockDeg
    )
    return speedAdjustedRate ^ cfg.rateIncreaseWithSpeed * cfg.steeringRate
end
--- All inputs/outputs are in the physical frame (positive = right), normalized to the steering lock.
-- Advances the three smoothers in `cx` and stores diagnostics in cx.d.dbg*.
function ____exports.calcCorrectedSteering(cx, targetFrontSlipDeg, initialSteering, absInitialSteering, assistFadeIn, brake, dt)
    local cfg = cx.cfg
    local d = cx.d
    local lock = cx.steer.lockDeg
    local fAng = d.fAxleVelAngle
    local rAng = d.rAxleVelAngle
    local inputSign = sgn(initialSteering)
    local midSpeedFade = lerpInvSat(d.hVelLen, 10 * d.wheelbaseFactor, 20 * d.wheelbaseFactor)
    local correctionExponent = 1 + (1 - log10(10 * (cfg.selfSteerResponse * 0.9 + 0.1)))
    local correctionBase = signedPow(
        clamp(rAng / 72, -1, 1),
        correctionExponent
    ) * 72 / lock
    local selfSteerCap = clamp01(cfg.maxSelfSteerAngle / lock)
    local selfSteerStrength = max(1, d.frontGrounded) * assistFadeIn
    local dampingForce = -d.yawRateRight * cfg.dampingStrength * 0.15 * (30 / lock)
    if cfg.reverseDampingFix then
        dampingForce = dampingForce * clamp(
            d.midVelFwd / max(0.25 * d.hVelLen, 0.5),
            -1,
            1
        )
    end
    local selfSteerCapT = min(1, 4 / (2 * selfSteerCap))
    local rawSelfSteer = clampEased(correctionBase, -selfSteerCap, selfSteerCap, selfSteerCapT) + dampingForce
    local selfSteerForce = clamp(
        cx.selfSteerSmoother:get(
            nanGuard(rawSelfSteer),
            dt
        ),
        -2,
        2
    ) * selfSteerStrength
    local finalTargetSlip = targetFrontSlipDeg * cfg.targetSlip
    local maxLimitReduction = lerp(
        finalTargetSlip * 0.4,
        finalTargetSlip * 0.75,
        clamp01(cfg.maxDynamicLimitReduction / 10)
    )
    local angleSubLimit = lerp(maxLimitReduction, maxLimitReduction * 0.9, brake)
    local clampedFAxleVelAngle = clampEased(-inputSign * fAng, -lock - 15, angleSubLimit, angleSubLimit * 0.4 / (lock + 15 + angleSubLimit))
    local isCountersteering = inputSign ~= 0 and inputSign == sgn(d.rVelRight) and abs(initialSteering) > 0.000001
    local rawCounterIndicator = isCountersteering and inverseLerpClampedEased(
        4.5,
        10,
        abs(rAng),
        0,
        1,
        0.6
    ) or 0
    local returnRate = lerp(
        0.8,
        0.3,
        lerpInvSat(
            abs(fAng - rAng),
            2,
            10
        )
    )
    local counterIndicator = cx.counterIndicatorSmoother:getMult(rawCounterIndicator, dt, rawCounterIndicator < cx.counterIndicatorSmoother.state and returnRate or 1) * midSpeedFade
    local antiSelfSteer = absInitialSteering * -selfSteerForce
    local targetInward = finalTargetSlip - clampedFAxleVelAngle
    local counterMult = lerp(
        lerpInvSat(inputSign * rAng, 0, 30) * (1 / 3) + 2 / 3,
        1,
        cfg.countersteerResponse
    )
    local targetCounter = finalTargetSlip * (cfg.countersteerResponse * counterMult * 0.7 + 0.1) + inputSign * rAng
    local targetSteeringAngle = lerp(
        clamp(targetInward, 0, lock),
        clamp(targetCounter, 0, lock),
        counterIndicator
    )
    local notForward = sin(clamp(
        rad(d.travelDirection * 2 / 3),
        -math.pi * 0.5,
        math.pi * 0.5
    )) ^ 16
    local smoothLimit = cx.limitSmoother:get(
        nanGuard(targetSteeringAngle, lock),
        dt
    )
    local limit = lerp(smoothLimit / lock, 1, notForward)
    d.dbgGrip = clamp01(limit)
    if cfg.rally then
        -- Rally v3. The stick has two zones:
        --   * 0 .. knee: sweeps 0 .. the grip limit (same limit as grip mode, so fine control at speed is kept)
        --   * knee .. 1: adds angle PAST the grip limit. How much is speed dependent: everything up to full lock
        --     when slow (hairpins), tapering to cfg.rallyExtraDeg above ~125 km/h so the top of the stick stays
        --     usable at speed instead of snapping to full lock.
        -- The curve's slope is continuous at the knee (no dead spot, no sudden jump in sensitivity).
        -- Self-steer / yaw damping stay strong for small inputs and fade out as the stick nears the knee; they come
        -- back when the stick is released, which straightens the car.
        local knee = cfg.rallyKnee
        local g = clamp(limit, 0.05, 1)
        local mag = abs(initialSteering)
        local fast = lerpInvSat(d.hVelLen, 10, 35)
        fast = fast * fast * (3 - 2 * fast)
        local room = 1 - g
        local extra = lerp(room, min(room, cfg.rallyExtraDeg / lock), fast)
        local t = clamp01((mag - knee) / (1 - knee))
        local a = extra > 0.000001 and clamp(g * (1 - knee) / (knee * extra), 0.15, 1) or 1
        local base = g * min(mag / knee, 1) + extra * (a * t + (1 - a) * t * t)
        local hold = clamp01(absInitialSteering / knee)
        local rallySelf = selfSteerForce * (1 - hold * hold)
        d.dbgLimit = g
        d.dbgGrip = g
        d.dbgMax = g + extra
        d.dbgSelfSteer = rallySelf
        d.dbgCounter = counterIndicator
        return clamp(inputSign * base + rallySelf, -1, 1)
    end
    d.dbgLimit = limit
    d.dbgMax = clamp01(limit)
    d.dbgSelfSteer = selfSteerForce
    d.dbgCounter = counterIndicator
    return clamp(initialSteering * limit + selfSteerForce + antiSelfSteer, -1, 1)
end
return ____exports
 end,
["agaSteering"] = function(...) 
local ____lualib = require("lualib_bundle")
local __TS__New = ____lualib.__TS__New
local ____exports = {}
local ____calibration = require("calibration")
local calibInputs = ____calibration.calibInputs
local finishCalibration = ____calibration.finishCalibration
local newSteerModel = ____calibration.newSteerModel
local normalizedSteeringToInput = ____calibration.normalizedSteeringToInput
local sweepAbortSeed = ____calibration.sweepAbortSeed
local ____config = require("config")
local applyConfig = ____config.applyConfig
local ____learn = require("learn")
local newFrontAxleSample = ____learn.newFrontAxleSample
local newLearnState = ____learn.newLearnState
local peakSlipEstimateDeg = ____learn.peakSlipEstimateDeg
local sampleFrontAxle = ____learn.sampleFrontAxle
local updateLearning = ____learn.updateLearning
local ____mathx = require("mathx")
local clamp = ____mathx.clamp
local clamp01 = ____mathx.clamp01
local lerp = ____mathx.lerp
local lerpInvSat = ____mathx.lerpInvSat
local lowpass = ____mathx.lowpass
local nanGuard = ____mathx.nanGuard
local sgn = ____mathx.sgn
local ____smooth = require("smooth")
local Smooth = ____smooth.Smooth
local ____steering = require("steering")
local calcCorrectedSteering = ____steering.calcCorrectedSteering
local calcSteeringRateMult = ____steering.calcSteeringRateMult
local fillFrameData = ____steering.fillFrameData
local newFrameData = ____steering.newFrameData
local abs = math.abs
local min = math.min
local max = math.max
local sqrt = math.sqrt
local atan2 = math.atan2
local deg = math.deg
local rad = math.rad
local huge = math.huge
--- pcall for closures that return several values (lua-types only models a single result).
local pcallMulti = pcall
local CONFIG_PATH = "settings/agaSteering.json"
local cfg = {}
--- set by setEnabled()/toggle(); survives config reloads until the vehicle is reloaded
local rallyOverride
local enabledOverride = nil
local steeringSmoother = __TS__New(
    Smooth,
    7,
    0.13,
    -1,
    1,
    0
)
local absSteeringSmoother = __TS__New(
    Smooth,
    7,
    0.13,
    -1,
    1,
    0
)
local selfSteerSmoother = __TS__New(
    Smooth,
    7,
    0.13,
    -1,
    1,
    0
)
local limitSmoother = __TS__New(
    Smooth,
    11,
    0.01,
    0,
    32,
    32
)
local groundedSmoother = __TS__New(
    Smooth,
    4,
    1,
    0,
    1,
    1
)
local counterIndicatorSmoother = __TS__New(
    Smooth,
    12,
    1,
    0,
    1,
    0
)
local targetSlipSmoother = __TS__New(
    Smooth,
    0.12,
    0.05,
    0,
    15,
    7
)
local frontWheels = {}
local rearWheels = {}
local ready = false
local wheelsByPosition = false
local steer = newSteerModel()
local calib = nil
local calibDone = false
local calibFails = 0
local calibStableT = 0
local signEvidence = 0
--- last steering_input we wrote (BeamNG convention)
local lastOut = 0
local lastFilterActive = false
local geomTimer = 0
local findTimer = 0
local findTries = 0
local function loadConfig()
    local data = nil
    local exists = true
    pcall(function()
        if FS and FS.fileExists and not FS:fileExists(CONFIG_PATH) then
            exists = false
        end
    end)
    if exists then
        local ok, res = pcall(jsonReadFile, CONFIG_PATH)
        if ok then
            data = res
        end
    end
    applyConfig(cfg, data, enabledOverride)
    if rallyOverride ~= nil then
        cfg.rally = rallyOverride
    end
end
local fwdX = 0
local fwdY = 1
local fwdZ = 0
local upX = 0
local upY = 0
local upZ = 1
local rgtX = 1
local rgtY = 0
local rgtZ = 0
local hasXYZ = nil
local function detectXYZ()
    hasXYZ = false
    local ok, x, ____, z = pcallMulti(function() return obj:getDirectionVectorXYZ() end)
    local ok2, x2, ____, z2 = pcallMulti(function() return obj:getDirectionVectorUpXYZ() end)
    if ok and ok2 and type(x) == "number" and type(z) == "number" and type(x2) == "number" and type(z2) == "number" then
        hasXYZ = true
    end
end
local function updateFrame()
    local fx
    local fy
    local fz
    local ux
    local uy
    local uz
    if hasXYZ then
        fx, fy, fz = obj:getDirectionVectorXYZ()
        ux, uy, uz = obj:getDirectionVectorUpXYZ()
    else
        local vec = obj:getDirectionVector()
        fx = vec.x
        fy = vec.y
        fz = vec.z
        vec = obj:getDirectionVectorUp()
        ux = vec.x
        uy = vec.y
        uz = vec.z
    end
    local ul = sqrt(ux * ux + uy * uy + uz * uz)
    if not (ul > 0.000001) then
        return false
    end
    ux = ux / ul
    uy = uy / ul
    uz = uz / ul
    local rx = fy * uz - fz * uy
    local ry = fz * ux - fx * uz
    local rz = fx * uy - fy * ux
    local rl = sqrt(rx * rx + ry * ry + rz * rz)
    if not (rl > 0.000001) then
        return false
    end
    rx = rx / rl
    ry = ry / rl
    rz = rz / rl
    fwdX = uy * rz - uz * ry
    fwdY = uz * rx - ux * rz
    fwdZ = ux * ry - uy * rx
    upX = ux
    upY = uy
    upZ = uz
    rgtX = rx
    rgtY = ry
    rgtZ = rz
    return true
end
--- forward coordinate of a wheel hub (m, relative to whatever getNodePosition is relative to; only differences are used)
local function wheelFwdPos(wd)
    local p1 = obj:getNodePosition(wd.node1)
    local p2 = obj:getNodePosition(wd.node2)
    return ((p1.x + p2.x) * fwdX + (p1.y + p2.y) * fwdY + (p1.z + p2.z) * fwdZ) * 0.5
end
local function findWheels()
    table.clear(frontWheels)
    table.clear(rearWheels)
    wheelsByPosition = false
    local all = {}
    for ____, wd in pairs(wheels.wheels or ({})) do
        if type(wd) == "table" and wd.node1 ~= nil and wd.node2 ~= nil then
            local hub = wd
            all[#all + 1] = hub
            local p = string.sub(
                tostring(hub.name or ""),
                1,
                1
            )
            if p == "F" then
                frontWheels[#frontWheels + 1] = hub
            elseif p == "R" then
                rearWheels[#rearWheels + 1] = hub
            end
        end
    end
    if (#frontWheels == 0 or #rearWheels == 0) and #all >= 2 then
        table.clear(frontWheels)
        table.clear(rearWheels)
        local ok = pcall(function()
            if not updateFrame() then
                error("frame")
            end
            local zs = {}
            local zmin = huge
            local zmax = -huge
            do
                local i = 0
                while i < #all do
                    local z = wheelFwdPos(all[i + 1])
                    if z ~= z then
                        error("nan")
                    end
                    zs[i + 1] = z
                    zmin = min(zmin, z)
                    zmax = max(zmax, z)
                    i = i + 1
                end
            end
            if zmax - zmin < 0.5 then
                return
            end
            local mid = (zmin + zmax) * 0.5
            do
                local i = 0
                while i < #all do
                    local ____temp_0 = zs[i + 1] > mid and frontWheels or rearWheels
                    ____temp_0[#____temp_0 + 1] = all[i + 1]
                    i = i + 1
                end
            end
        end)
        if not ok then
            table.clear(frontWheels)
            table.clear(rearWheels)
        end
        wheelsByPosition = #frontWheels > 0 and #rearWheels > 0
    end
    return #frontWheels > 0 and #rearWheels > 0
end
--- Averages the hub velocity (and optionally the steer angle) of all intact wheels of an axle.
-- Returns: velRight, velFwd, count, angleDeg (positive = pointing right), grounded
local function axleState(list, wantAngle)
    local vr = 0
    local vf = 0
    local n = 0
    local ang = 0
    local na = 0
    local grounded = false
    for i = 1, #list do
        local wd = list[i]
        if not wd.isBroken then
            local v1 = obj:getNodeVelocityVector(wd.node1)
            local v2 = obj:getNodeVelocityVector(wd.node2)
            local wx = (v1.x + v2.x) * 0.5
            local wy = (v1.y + v2.y) * 0.5
            local wz = (v1.z + v2.z) * 0.5
            local lr = wx * rgtX + wy * rgtY + wz * rgtZ
            local lf = wx * fwdX + wy * fwdY + wz * fwdZ
            if lr == lr and lf == lf and abs(lr) < 1000 and abs(lf) < 1000 then
                vr = vr + lr
                vf = vf + lf
                n = n + 1
                if (wd.downForceRaw or 0) > 0 then
                    grounded = true
                end
                if wantAngle then
                    local p1 = obj:getNodePosition(wd.node1)
                    local p2 = obj:getNodePosition(wd.node2)
                    local ax = p2.x - p1.x
                    local ay = p2.y - p1.y
                    local az = p2.z - p1.z
                    local qx = upY * az - upZ * ay
                    local qy = upZ * ax - upX * az
                    local qz = upX * ay - upY * ax
                    local f = qx * fwdX + qy * fwdY + qz * fwdZ
                    local r = qx * rgtX + qy * rgtY + qz * rgtZ
                    if f < 0 then
                        f = -f
                        r = -r
                    end
                    local a = deg(atan2(r, f))
                    if a == a and abs(f) + abs(r) > 1e-9 then
                        ang = ang + a
                        na = na + 1
                    end
                end
            end
        end
    end
    if n > 0 then
        vr = vr / n
        vf = vf / n
    end
    if na > 0 then
        ang = ang / na
    end
    return vr, vf, n, ang, grounded
end
local wheelbase = 2.5
local function updateGeometry()
    local fz = 0
    local nf = 0
    local rz = 0
    local nr = 0
    for i = 1, #frontWheels do
        local wd = frontWheels[i]
        if not wd.isBroken then
            fz = fz + wheelFwdPos(wd)
            nf = nf + 1
        end
    end
    for i = 1, #rearWheels do
        local wd = rearWheels[i]
        if not wd.isBroken then
            rz = rz + wheelFwdPos(wd)
            nr = nr + 1
        end
    end
    if nf > 0 and nr > 0 then
        local wb = abs(fz / nf - rz / nr)
        if wb == wb and wb < 50 then
            wheelbase = max(wb, 0.5)
        end
    end
end
local function setUnsupported(msg)
    steer.unsupported = true
    calibDone = true
    guihooks.message(("AGA Steering: " .. msg) .. " - assist disabled for this vehicle", 6, "agaSteering")
    log("W", "agaSteering", msg .. " - assist disabled for this vehicle")
end
--- Standstill calibration: steps steering_input through calibInputs, waits for the (rate limited) steering hydros
-- to settle at each step and records the real front wheel angle. Also yields the sign convention and zero offset.
-- Returns the steering_input to write while calibrating, or nil when not calibrating.
local function updateCalibration(dt, speed, rawStick, throttle, frontAngle, rearAngle)
    if calibDone or not cfg.calibrate then
        return nil
    end
    if calib == nil then
        if speed < 0.3 and abs(rawStick) < 0.05 and throttle < 0.1 then
            calibStableT = calibStableT + dt
        else
            calibStableT = 0
        end
        if calibStableT < 1 then
            return nil
        end
        calib = {
            idx = 0,
            t = 0,
            settle = 0,
            ref = frontAngle,
            lp = frontAngle,
            samples = {},
            zeroF = 0,
            zeroR = 0
        }
    end
    local c = calib
    if speed > 1 or abs(rawStick) > 0.15 or throttle > 0.3 then
        local tgt = sweepAbortSeed(steer, c.idx)
        calib = nil
        calibStableT = 0
        local s = steer.sign ~= 0 and steer.sign or 1
        steeringSmoother.state = s * tgt
        absSteeringSmoother.state = tgt
        return nil
    end
    local target = c.idx == 0 and 0 or calibInputs[c.idx]
    c.t = c.t + dt
    c.lp = c.lp + (frontAngle - c.lp) * min(1, dt / 0.04)
    if abs(c.lp - c.ref) > 0.1 then
        c.ref = c.lp
        c.settle = 0
    else
        c.settle = c.settle + dt
    end
    local minT = c.idx == 0 and 0.4 or 0.2
    if c.settle > 0.15 and c.t > minT or c.t > 2.5 then
        if c.idx == 0 then
            c.zeroF = c.lp
            c.zeroR = rearAngle
        else
            c.samples[c.idx] = c.lp - c.zeroF
        end
        if c.idx == #calibInputs then
            local res = finishCalibration(steer, c.samples, rearAngle - c.zeroR)
            local zero = c.zeroF
            calib = nil
            calibStableT = 0
            if res == "ok" then
                calibDone = true
                steer.zeroDeg = zero
                steeringSmoother.state = steer.sign
                absSteeringSmoother.state = 1
                guihooks.message(
                    string.format("AGA Steering: calibrated (lock %.1f deg)", steer.lockDeg),
                    4,
                    "agaSteering"
                )
                log(
                    "I",
                    "agaSteering",
                    string.format(
                        "calibration lock=%.2f sign=%d zero=%.2f curve=%s",
                        steer.lockDeg,
                        steer.sign,
                        steer.zeroDeg,
                        dumps(steer.curveOut)
                    )
                )
            elseif res == "rearsteer" then
                setUnsupported("rear-wheel steering detected")
            else
                calibFails = calibFails + 1
                if calibFails >= 2 then
                    setUnsupported(res == "nosteer" and "front wheels do not respond to steering" or "could not measure the steering lock")
                else
                    log("W", "agaSteering", ("steering calibration failed (" .. res) .. "), retrying")
                end
            end
            return 0
        end
        c.idx = c.idx + 1
        c.t = 0
        c.settle = 0
        target = calibInputs[c.idx]
    end
    return target
end
--- Passive detection of the steering_input sign while driving (used until the calibration has run):
-- correlate what we commanded with what the front wheels actually did.
local function updateSignDetection(dt, frontAngle)
    if abs(lastOut) > 0.15 and abs(frontAngle) > 2 then
        signEvidence = signEvidence + lastOut * frontAngle * dt
    end
    signEvidence = signEvidence * (1 - min(1, dt / 5))
    if abs(signEvidence) > 0.3 then
        steer.sign = sgn(signEvidence)
        log(
            "I",
            "agaSteering",
            "steering direction detected while driving: sign=" .. tostring(steer.sign)
        )
    end
end
local assistedSurfaces = {
    METAL = 1,
    PLASTIC = 1,
    RUBBER = 1,
    GLASS = 1,
    WOOD = 1,
    ASPHALT = 1,
    ROCK = 1,
    RUMBLE_STRIP = 1,
    COBBLESTONE = 1
}
local SURFACE_RETRY_SECONDS = 5
local surfaceCache = nil
--- the material table was readable and contained at least one assisted surface
local surfaceCacheOk = false
local surfaceRetryT = 0
local function buildSurfaceCache()
    local cache = {}
    surfaceCacheOk = false
    local ok, t = pcall(function() return particles.getMaterialsParticlesTable() end)
    if ok and type(t) == "table" then
        for k, mat in pairs(t) do
            if type(mat) == "table" then
                local assisted = assistedSurfaces[mat.name]
                cache[k] = assisted
                if assisted ~= nil then
                    surfaceCacheOk = true
                end
            end
        end
    end
    surfaceCache = cache
    return cache
end
local function isTarmac(matId)
    local cache = surfaceCache or buildSurfaceCache()
    return matId ~= nil and cache[matId] ~= nil
end
--- The material table can be unavailable (or still empty) early on: keep retrying instead of never learning.
local function retrySurfaceCache(dt)
    if surfaceCacheOk or surfaceCache == nil then
        return
    end
    surfaceRetryT = surfaceRetryT + dt
    if surfaceRetryT >= SURFACE_RETRY_SECONDS then
        surfaceRetryT = 0
        buildSurfaceCache()
    end
end
local learn = newLearnState()
local learnFilters = {lp = {}, stillT = 0}
local frontAxle = newFrontAxleSample()
local LEARNED_PATH = "settings/agaSteering_learned.json"
local learnSaveT = 0
local cachedLearnKey = nil
local lastSaved = nil
local saveWarned = false
--- Tyre parts that identify the learned data: everything named *tire*, except spare tyres (they are not driven on).
local function isLearnKeyTyre(partName)
    if (string.find(partName, "tire", 1, true)) == nil then
        return false
    end
    return (string.find(
        string.lower(partName),
        "spare",
        1,
        true
    )) == nil
end
local function learnKey()
    if cachedLearnKey ~= nil then
        return cachedLearnKey
    end
    local c = v and v.config
    if not c then
        return nil
    end
    local tyres = {}
    local seen = {}
    local function walk(t, depth)
        if type(t) ~= "table" or depth > 40 then
            return
        end
        local node = t
        local p = node.chosenPartName
        if type(p) == "string" and isLearnKeyTyre(p) and not seen[p] then
            seen[p] = true
            tyres[#tyres + 1] = p
        end
        for ____, ch in pairs(node) do
            if type(ch) == "table" then
                walk(ch, depth + 1)
            end
        end
    end
    walk(c.partsTree, 0)
    table.sort(tyres)
    cachedLearnKey = (tostring(c.model or c.mainPartName or "?") .. "|") .. table.concat(tyres, ",")
    return cachedLearnKey
end
local function readLearned()
    local ok, t = pcall(jsonReadFile, LEARNED_PATH)
    return ok and type(t) == "table" and t or ({})
end
local function saveLearned()
    if not learn.dirty or not cfg.learnPeakSlip or cfg.peakSlipDeg > 0 then
        return
    end
    local key = learnKey()
    local C0 = learn.C0
    local muMax = learn.muMax
    if key == nil or C0 == nil or muMax == nil then
        return
    end
    if lastSaved ~= nil and abs(lastSaved.C0 - C0) < 0.01 * lastSaved.C0 and abs(lastSaved.muMax - muMax) < 0.01 and min(learn.n, 300) - lastSaved.n < 15 then
        learn.dirty = false
        return
    end
    local all = readLearned()
    local entry = {
        C0 = C0,
        muMax = muMax,
        n = min(learn.n, 300)
    }
    all[key] = entry
    local ok, res = pcall(jsonWriteFile, LEARNED_PATH, all, true)
    if ok and res ~= false then
        learn.dirty = false
        lastSaved = entry
    elseif not saveWarned then
        saveWarned = true
        log(
            "W",
            "agaSteering",
            (("could not save learned tyre data to " .. LEARNED_PATH) .. ": ") .. tostring(res)
        )
    end
end
local function restoreLearned()
    if not cfg.learnPeakSlip or cfg.peakSlipDeg > 0 then
        return
    end
    local key = learnKey()
    if key == nil then
        return
    end
    local e = readLearned()[key]
    if type(e) ~= "table" or type(e.C0) ~= "number" or type(e.muMax) ~= "number" then
        return
    end
    local C0 = clamp(e.C0, 1, 200)
    local muMax = clamp(e.muMax, learn.muPrior * 0.8, 2.5)
    learn.C0 = C0
    learn.muMax = muMax
    learn.n = clamp(
        tonumber(e.n) or 0,
        0,
        300
    )
    lastSaved = {C0 = C0, muMax = muMax, n = learn.n}
    local est = peakSlipEstimateDeg(muMax, C0)
    targetSlipSmoother.state = lerp(
        learn.default,
        est,
        clamp01(learn.n / 300)
    )
end
local function resetLearning()
    local mu = 1
    local ok, coef = pcall(function() return obj:getStaticFrictionCoef() end)
    if ok and type(coef) == "number" and coef == coef then
        mu = coef
    end
    learn.muPrior = clamp(mu, 0.5, 1.8)
    learn.muMax = learn.muPrior
    learn.cfgPeak = cfg.peakSlipDeg
    learn.default = cfg.peakSlipDeg > 0 and cfg.peakSlipDeg or clamp(11 - 3 * learn.muPrior, 5, 10)
    learn.C0 = 2.4 * learn.muPrior / rad(learn.default)
    learn.n = 0
    learn.lastFz = nil
    learn.mF = nil
    learn.mFn = 0
    table.clear(learnFilters.lp)
    learnFilters.stillT = 0
    targetSlipSmoother.state = learn.default
    learn.dirty = false
    restoreLearned()
end
local function updateTargetSlip(dd, dt)
    if not cfg.learnPeakSlip then
        targetSlipSmoother.state = learn.default
        learn.why = 0
        learn.dbg = nil
        return
    end
    retrySurfaceCache(dt)
    local g = abs(nanGuard(
        obj:getGravity(),
        -9.81
    ))
    if g < 1 then
        g = 9.81
    end
    sampleFrontAxle(frontAxle, frontWheels, dd, isTarmac)
    local ay = abs(nanGuard(sensors.gx2 or sensors.gx))
    local ax = abs(nanGuard(sensors.gy2 or sensors.gy))
    updateLearning(
        learn,
        learnFilters,
        targetSlipSmoother,
        dd,
        frontAxle,
        #frontWheels,
        g,
        ay,
        ax,
        dt
    )
end
local d = newFrameData()
local velLP = {}
local function gatherData(dt)
    if not updateFrame() then
        return nil
    end
    local fvx, fvz, nf, fAng, fGrounded = axleState(frontWheels, true)
    local rvx, rvz, nr, rAngSteer = axleState(rearWheels, calib ~= nil)
    if nf == 0 or nr == 0 then
        return nil
    end
    geomTimer = geomTimer - dt
    if geomTimer <= 0 then
        geomTimer = 1
        updateGeometry()
    end
    if cfg.velocitySmoothing > 0 then
        local tau = cfg.velocitySmoothing
        fvx = lowpass(
            velLP,
            1,
            fvx,
            dt,
            tau
        )
        fvz = lowpass(
            velLP,
            2,
            fvz,
            dt,
            tau
        )
        rvx = lowpass(
            velLP,
            3,
            rvx,
            dt,
            tau
        )
        rvz = lowpass(
            velLP,
            4,
            rvz,
            dt,
            tau
        )
    end
    fillFrameData(
        d,
        fvx,
        fvz,
        rvx,
        rvz,
        wheelbase,
        fAng,
        rAngSteer,
        steer.zeroDeg
    )
    d.frontGrounded = groundedSmoother:get(fGrounded and 1 or 0, dt)
    return d
end
local steeringContext = {
    cfg = cfg,
    d = d,
    steer = steer,
    selfSteerSmoother = selfSteerSmoother,
    counterIndicatorSmoother = counterIndicatorSmoother,
    limitSmoother = limitSmoother
}
local function resetState()
    steeringSmoother:reset()
    absSteeringSmoother:reset()
    selfSteerSmoother:reset()
    limitSmoother:reset()
    groundedSmoother:reset()
    counterIndicatorSmoother:reset()
    table.clear(velLP)
    lastOut = 0
end
--- 0 = hands off, 1 = calibration allowed but no processing (e.g. no pad input seen yet), 2 = full processing
local function activeLevel()
    if not cfg.enabled or not ready or steer.unsupported then
        return 0
    end
    if not playerInfo.anyPlayerSeated then
        return 0
    end
    if ai and ai.isDriving and ai.isDriving() then
        return 0
    end
    local st = input.state and input.state.steering
    if not st then
        return 0
    end
    local f = st.filter
    if f == nil then
        return 0
    end
    if f == FILTER_PAD then
        return 2
    end
    if f == FILTER_KBD or f == FILTER_KBD2 then
        return cfg.applyToKeyboard and 2 or 1
    end
    return 0
end
local function writeSteering(value)
    lastOut = value
    input.steering = value
    electrics.values.steering_input = value
end
local function deactivate()
    d.dbgFade = 0
    d.dbgOut = 0
    d.dbgStick = 0
    if lastFilterActive then
        resetState()
    end
    lastFilterActive = false
end
--- live status for the in-game UI app (read through the 'electrics' stream)
local function publishStatus(level)
    local ev = electrics.values
    ev.agaEnabled = cfg.enabled and 1 or 0
    ev.agaActive = level
    ev.agaRally = cfg.rally and 1 or 0
    ev.agaCalibrated = steer.calibrated and 1 or 0
    ev.agaCalibrating = calib ~= nil and 1 or 0
    ev.agaUnsupported = steer.unsupported and 1 or 0
    ev.agaLockDeg = steer.lockDeg
    ev.agaPeakSlip = targetSlipSmoother.state
    ev.agaLearn = clamp01(learn.n / 300)
    ev.agaLearnWhy = learn.why or 0
    local fade = level == 2 and (d.dbgFade or 0) or 0
    ev.agaLimit = 1 + (nanGuard(d.dbgLimit or 1, 1) - 1) * fade
    ev.agaSelfSteer = nanGuard(d.dbgSelfSteer or 0, 0) * fade
    -- steering gauge for the UI app: everything normalized to the steering lock, positive = right
    local live = level == 2 and calib == nil
    ev.agaOut = live and clamp(nanGuard(d.dbgOut or 0, 0), -1, 1) or 0
    ev.agaStick = live and clamp(nanGuard(d.dbgStick or 0, 0), -1, 1) or 0
    ev.agaGrip = 1 + (clamp01(nanGuard(d.dbgGrip or 1, 1)) - 1) * fade
    ev.agaMax = 1 + (clamp01(nanGuard(d.dbgMax or 1, 1)) - 1) * fade
    ev.agaCounter = nanGuard(d.dbgCounter or 0, 0) * fade
end
local function updateGFX(dt)
    if dt == nil or not (dt > 0) then
        return
    end
    if dt > 0.1 then
        dt = 0.1
    end
    if not ready then
        publishStatus(0)
        if not cfg.enabled or findTries >= 3 or not playerInfo.anyPlayerSeated then
            return
        end
        findTimer = findTimer + dt
        if findTimer < 2 then
            return
        end
        findTimer = 0
        findTries = findTries + 1
        ready = findWheels()
        if not ready then
            return
        end
    end
    local level = activeLevel()
    publishStatus(level)
    if level == 0 or level == 1 and (calibDone or not cfg.calibrate) then
        calib = nil
        calibStableT = 0
        deactivate()
        return
    end
    local data = gatherData(dt)
    if data == nil then
        calib = nil
        calibStableT = 0
        deactivate()
        return
    end
    local rawStick = clamp(
        nanGuard(input.state.steering.val),
        -1,
        1
    )
    local throttle = abs(nanGuard(electrics.values.throttle_input or input.throttle))
    local calOverride = updateCalibration(
        dt,
        data.hVelLen,
        rawStick,
        throttle,
        data.rawSteerAngle,
        data.rearSteerAngle
    )
    if calOverride ~= nil then
        d.dbgFade = 0
        writeSteering(calOverride)
        return
    end
    if steer.unsupported or level < 2 then
        deactivate()
        return
    end
    local signKnown = steer.sign ~= 0
    local s = signKnown and steer.sign or 1
    local stick = s * rawStick
    lastFilterActive = true
    local brake = clamp01(nanGuard(electrics.values.brake_input or input.brake))
    local steeringRateMult = calcSteeringRateMult(cfg, data.hVelLen, steer.lockDeg)
    local centeringRate = 1
    if steeringRateMult > 0 and steeringRateMult < 0.5 then
        local st = steeringSmoother.state
        if abs(stick) < abs(st) and sgn(stick) == sgn(st) or sgn(stick) ~= sgn(st) then
            centeringRate = (steeringRateMult * 0.5 + 0.25) / steeringRateMult
        end
    end
    local initialSteering = steeringSmoother:getMult(stick, dt, steeringRateMult * centeringRate)
    local absInitialSteering = absSteeringSmoother:getMult(
        abs(stick),
        dt,
        steeringRateMult * centeringRate
    )
    if not signKnown then
        updateSignDetection(dt, data.steerAngle)
        steer.signRamp = 0
    elseif steer.signRamp < 1 then
        steer.signRamp = min(1, steer.signRamp + dt * 2)
    end
    updateTargetSlip(data, dt)
    learnSaveT = learnSaveT + dt
    if learnSaveT > 30 then
        learnSaveT = 0
        saveLearned()
    end
    local assistFadeIn = lerpInvSat(data.fAxleHVelLen, 2 * data.wheelbaseFactor, 6 * data.wheelbaseFactor) * steer.signRamp
    local processed = calcCorrectedSteering(
        steeringContext,
        targetSlipSmoother.state,
        initialSteering,
        absInitialSteering,
        assistFadeIn,
        brake,
        dt
    )
    local desired = lerp(initialSteering, processed, assistFadeIn)
    d.dbgFade = assistFadeIn
    d.dbgOut = desired
    d.dbgStick = stick
    local out = s * clamp(
        nanGuard(normalizedSteeringToInput(steer, desired)),
        -1,
        1
    )
    writeSteering(out)
    if cfg.debug then
        guihooks.graph(
            {"stick", rawStick, 1, ""},
            {"out", out, 1, ""},
            {"frontSlip", data.frontSlipDeg, 20, "deg"},
            {"targetSlip", targetSlipSmoother.state, 20, "deg"},
            {"limit", d.dbgLimit or 0, 1, ""},
            {"selfSteer", d.dbgSelfSteer or 0, 1, ""},
            {"counter", d.dbgCounter or 0, 1, ""}
        )
    end
end
local function resetCalibrationState()
    calib = nil
    calibDone = false
    calibFails = 0
    calibStableT = 0
    steer.unsupported = false
end
local function init()
    cachedLearnKey = nil
    lastSaved = nil
    loadConfig()
    detectXYZ()
    ready = findWheels()
    resetState()
    resetLearning()
    resetCalibrationState()
    steer.lockDeg = 35
    steer.curveIn = {0, 1}
    steer.curveOut = {0, 1}
    steer.sign = 0
    steer.zeroDeg = 0
    steer.calibrated = false
    steer.signRamp = 0
    signEvidence = 0
    geomTimer = 0
    lastFilterActive = false
    findTimer = 0
    findTries = 0
    if not ready then
        log("D", "agaSteering", "Could not identify front/rear wheels; assist inactive for this vehicle")
    elseif wheelsByPosition then
        log("I", "agaSteering", "No F*/R* wheel names; front/rear wheels identified by position")
    end
end
local function onReset()
    saveLearned()
    loadConfig()
    ready = findWheels()
    resetState()
    lastFilterActive = false
    calib = nil
    calibStableT = 0
    geomTimer = 0
    table.clear(learnFilters.lp)
    learn.lastFz = nil
    learnFilters.stillT = 0
    if not cfg.learnPeakSlip or learn.cfgPeak ~= cfg.peakSlipDeg then
        resetLearning()
    end
end
local function onSettingsChanged()
    saveLearned()
    loadConfig()
    if learn.cfgPeak ~= cfg.peakSlipDeg then
        resetLearning()
    end
end
function ____exports.onExtensionLoaded()
    return true
end
function ____exports.onExtensionUnloaded()
    saveLearned()
end
____exports.saveLearned = saveLearned
--- jbeam/wheels are ready here (auto extensions are loaded right before this hook)
____exports.onVehicleLoaded = init
____exports.onReset = onReset
____exports.updateGFX = updateGFX
____exports.onSettingsChanged = onSettingsChanged
-- Mode API (v3.4). One source of truth: the car owns the mode ("off" | "grip" | "rally"), shows the message,
-- saves it to the settings file and syncs every other spawned car. The UI app and the key bindings all call this.
local MODE_TEXT = {
    off = "AGA OFF  -  stock BeamNG steering",
    grip = "AGA GRIP  -  steering stops at the grip limit",
    rally = "AGA RALLY  -  push the stick all the way to steer past the grip limit"
}
function ____exports.getMode()
    if not cfg.enabled then
        return "off"
    end
    return cfg.rally and "rally" or "grip"
end
--- quiet update, used to sync the other cars
function ____exports.syncMode(en, rally)
    enabledOverride = en and true or false
    rallyOverride = rally and true or false
    cfg.enabled = enabledOverride
    cfg.rally = rallyOverride
end
function ____exports.setMode(mode, quiet)
    if mode ~= "off" and mode ~= "grip" and mode ~= "rally" then
        return
    end
    local en = mode ~= "off"
    local rally = cfg.rally and true or false
    if en then
        rally = mode == "rally"
    end
    ____exports.syncMode(en, rally)
    if not quiet then
        guihooks.message(MODE_TEXT[mode], 3, "agaSteeringMode")
    end
    local e = tostring(en)
    local r = tostring(rally)
    pcall(function()
        obj:queueGameEngineLua("local p='settings/agaSteering.json' local c=jsonReadFile(p) or {} c.enabled=" .. e .. " c.rally=" .. r .. " jsonWriteFile(p,c,true) be:queueAllObjectLua('local a=extensions.agaSteering if a and a.syncMode then a.syncMode(" .. e .. "," .. r .. ") end')")
    end)
end
function ____exports.setEnabled(b)
    ____exports.setMode(b and (cfg.rally and "rally" or "grip") or "off")
end
function ____exports.toggle()
    ____exports.setEnabled(not cfg.enabled)
end
function ____exports.setRally(b)
    ____exports.setMode(b and "rally" or "grip")
end
--- View button: flips GRIP <-> RALLY (and switches the assist on if it was off)
function ____exports.toggleRally()
    ____exports.setMode(cfg.enabled and cfg.rally and "grip" or "rally")
end
function ____exports.syncRally(b)
    rallyOverride = b and true or false
    cfg.rally = rallyOverride
end
--- called by the UI app after it saved slider changes; the live mode (overrides) is kept
function ____exports.reloadConfig()
    onSettingsChanged()
end
function ____exports.recalibrate()
    resetCalibrationState()
end
function ____exports.getState()
    return {
        lock = steer.lockDeg,
        curve = steer.curveOut,
        curveIn = steer.curveIn,
        sign = steer.sign,
        zero = steer.zeroDeg,
        calibrated = steer.calibrated,
        unsupported = steer.unsupported,
        wheelbase = wheelbase,
        wheelsByPosition = wheelsByPosition,
        ready = ready,
        targetSlip = targetSlipSmoother.state,
        learnSamples = learn.n,
        learnWhy = learn.why,
        learnDbg = learn.dbg,
        learnMuMax = learn.muMax,
        learnC0 = learn.C0,
        frontStaticMass = learn.mF,
        cfg = cfg
    }
end
return ____exports
 end,
}
local ____entry = require("agaSteering", ...)
return ____entry
