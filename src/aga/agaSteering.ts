// AGA Steering for BeamNG.drive - extension entry point (everything that touches the BeamNG API lives here).
// See src/header.lua for the user-facing description and attribution; it is prepended to the build output.
//
// The pure maths is in mathx / smooth / config / calibration / learn / steering and is unit-tested under Node.
// This file is only exercised by the LuaJIT integration harness, so it may use Lua-only constructs
// (multiple returns, pcall, pairs, ...).
import { calibInputs, finishCalibration, newSteerModel, normalizedSteeringToInput, sweepAbortSeed } from "./calibration";
import { applyConfig } from "./config";
import type { Config } from "./config";
import { newFrontAxleSample, newLearnState, peakSlipEstimateDeg, sampleFrontAxle, updateLearning } from "./learn";
import type { LearnFilters } from "./learn";
import { clamp, clamp01, lerp, lerpInvSat, lowpass, nanGuard, sgn } from "../core/mathx";
import { humanDriving, readSettingsFile, saveSettingsFromVehicle } from "../core/vehicle";
import type { LowpassStates } from "../core/mathx";
import { Smooth } from "./smooth";
import { calcCorrectedSteering, calcSteeringRateMult, fillFrameData, newFrameData } from "./steering";
import type { FrameData, SteeringContext } from "./steering";

const abs = math.abs;
const min = math.min;
const max = math.max;
const sqrt = math.sqrt;
const atan2 = math.atan2;
const deg = math.deg;
const rad = math.rad;
const huge = math.huge;

/** pcall for closures that return several values (lua-types only models a single result). */
const pcallMulti = pcall as unknown as <A extends unknown[]>(
  this: void,
  f: (this: void) => LuaMultiReturn<A>,
) => LuaMultiReturn<[boolean, ...{ [K in keyof A]: A[K] | undefined }]>;

const CONFIG_PATH = "settings/agaSteering.json";

// Empty until the first loadConfig() (vehicle load), exactly like the Lua original: every flag reads as "off".
const cfg = {} as Config;
/** set by setEnabled()/toggle(); survives config reloads until the vehicle is reloaded */
let enabledOverride: boolean | undefined = undefined;
/** set by the mode API (setMode / syncMode); survives config reloads until the vehicle is reloaded */
let rallyOverride: boolean | undefined = undefined;

// ===== state =============================================================================
const steeringSmoother = new Smooth(7.0, 0.13, -1, 1, 0);
const absSteeringSmoother = new Smooth(7.0, 0.13, -1, 1, 0);
const selfSteerSmoother = new Smooth(7.0, 0.13, -1, 1, 0);
const limitSmoother = new Smooth(11.0, 0.01, 0, 32, 32);
const groundedSmoother = new Smooth(4.0, 1.0, 0, 1, 1);
const counterIndicatorSmoother = new Smooth(12.0, 1.0, 0, 1, 0);
const targetSlipSmoother = new Smooth(0.12, 0.05, 0, 15, 7);

const frontWheels: HubWheel[] = [];
const rearWheels: HubWheel[] = [];
let ready = false;
let wheelsByPosition = false;

const steer = newSteerModel();

/** Active calibration sweep. idx 0 = measuring the zero position, idx i = settling at calibInputs[i - 1]. */
interface CalibSweep {
  idx: number;
  t: number;
  settle: number;
  ref: number;
  lp: number;
  samples: number[];
  zeroF: number;
  zeroR: number;
}
let calib: CalibSweep | undefined = undefined;
let calibDone = false;
let calibFails = 0;
let calibStableT = 0;
let signEvidence = 0;
/** last steering_input we wrote (BeamNG convention) */
let lastOut = 0;

let lastFilterActive = false;
let geomTimer = 0;
let findTimer = 0;
let findTries = 0;

// ===== config ============================================================================
function loadConfig(): void {
  applyConfig(cfg, readSettingsFile(CONFIG_PATH), enabledOverride);
  if (rallyOverride !== undefined) cfg.rally = rallyOverride;
}

// ===== vehicle frame & wheels ==============================================================
// Orthonormal body frame as plain numbers (no per-frame vec3 allocations on our side).
let fwdX = 0;
let fwdY = 1;
let fwdZ = 0;
let upX = 0;
let upY = 0;
let upZ = 1;
let rgtX = 1;
let rgtY = 0;
let rgtZ = 0;
let hasXYZ: boolean | undefined = undefined;

function detectXYZ(): void {
  hasXYZ = false;
  const [ok, x, , z] = pcallMulti(() => obj.getDirectionVectorXYZ());
  const [ok2, x2, , z2] = pcallMulti(() => obj.getDirectionVectorUpXYZ());
  if (
    ok &&
    ok2 &&
    type(x) === "number" &&
    type(z) === "number" &&
    type(x2) === "number" &&
    type(z2) === "number"
  ) {
    hasXYZ = true;
  }
}

function updateFrame(): boolean {
  let fx: number, fy: number, fz: number, ux: number, uy: number, uz: number;
  if (hasXYZ) {
    [fx, fy, fz] = obj.getDirectionVectorXYZ();
    [ux, uy, uz] = obj.getDirectionVectorUpXYZ();
  } else {
    let vec = obj.getDirectionVector();
    fx = vec.x;
    fy = vec.y;
    fz = vec.z;
    vec = obj.getDirectionVectorUp();
    ux = vec.x;
    uy = vec.y;
    uz = vec.z;
  }
  const ul = sqrt(ux * ux + uy * uy + uz * uz);
  if (!(ul > 1e-6)) return false;
  ux = ux / ul;
  uy = uy / ul;
  uz = uz / ul;
  // right = fwd x up (BeamNG is right-handed, z up)
  let rx = fy * uz - fz * uy;
  let ry = fz * ux - fx * uz;
  let rz = fx * uy - fy * ux;
  const rl = sqrt(rx * rx + ry * ry + rz * rz);
  if (!(rl > 1e-6)) return false;
  rx = rx / rl;
  ry = ry / rl;
  rz = rz / rl;
  // re-orthogonalized forward = up x right
  fwdX = uy * rz - uz * ry;
  fwdY = uz * rx - ux * rz;
  fwdZ = ux * ry - uy * rx;
  upX = ux;
  upY = uy;
  upZ = uz;
  rgtX = rx;
  rgtY = ry;
  rgtZ = rz;
  return true;
}

/** forward coordinate of a wheel hub (m, relative to whatever getNodePosition is relative to; only differences are used) */
function wheelFwdPos(wd: HubWheel): number {
  const p1 = obj.getNodePosition(wd.node1);
  const p2 = obj.getNodePosition(wd.node2);
  return ((p1.x + p2.x) * fwdX + (p1.y + p2.y) * fwdY + (p1.z + p2.z) * fwdZ) * 0.5;
}

function findWheels(): boolean {
  table.clear(frontWheels);
  table.clear(rearWheels);
  wheelsByPosition = false;
  const all: HubWheel[] = [];
  for (const [, wd] of pairs(wheels.wheels ?? new LuaTable<number, WheelData | undefined>())) {
    if (type(wd) === "table" && wd!.node1 !== undefined && wd!.node2 !== undefined) {
      const hub = wd as HubWheel;
      all.push(hub);
      const p = string.sub(tostring(hub.name ?? ""), 1, 1);
      if (p === "F") frontWheels.push(hub);
      else if (p === "R") rearWheels.push(hub);
    }
  }
  if ((frontWheels.length === 0 || rearWheels.length === 0) && all.length >= 2) {
    // no usable F*/R* names: split the wheels by their position along the car instead
    table.clear(frontWheels);
    table.clear(rearWheels);
    const [ok] = pcall(() => {
      if (!updateFrame()) error("frame");
      const zs: number[] = [];
      let zmin = huge;
      let zmax = -huge;
      for (let i = 0; i < all.length; i++) {
        const z = wheelFwdPos(all[i]!);
        if (z !== z) error("nan");
        zs[i] = z;
        zmin = min(zmin, z);
        zmax = max(zmax, z);
      }
      if (zmax - zmin < 0.5) return;
      const mid = (zmin + zmax) * 0.5;
      for (let i = 0; i < all.length; i++) {
        (zs[i]! > mid ? frontWheels : rearWheels).push(all[i]!);
      }
    });
    if (!ok) {
      table.clear(frontWheels);
      table.clear(rearWheels);
    }
    wheelsByPosition = frontWheels.length > 0 && rearWheels.length > 0;
  }
  return frontWheels.length > 0 && rearWheels.length > 0;
}

/**
 * Averages the hub velocity (and optionally the steer angle) of all intact wheels of an axle.
 * Returns: velRight, velFwd, count, angleDeg (positive = pointing right), grounded
 */
function axleState(
  list: readonly HubWheel[],
  wantAngle: boolean,
): LuaMultiReturn<[velRight: number, velFwd: number, count: number, angleDeg: number, grounded: boolean]> {
  let vr = 0;
  let vf = 0;
  let n = 0;
  let ang = 0;
  let na = 0;
  let grounded = false;
  for (const i of $range(1, list.length)) {
    const wd = list[i - 1]!;
    if (!wd.isBroken) {
      const v1 = obj.getNodeVelocityVector(wd.node1);
      const v2 = obj.getNodeVelocityVector(wd.node2);
      const wx = (v1.x + v2.x) * 0.5;
      const wy = (v1.y + v2.y) * 0.5;
      const wz = (v1.z + v2.z) * 0.5;
      const lr = wx * rgtX + wy * rgtY + wz * rgtZ;
      const lf = wx * fwdX + wy * fwdY + wz * fwdZ;
      if (lr === lr && lf === lf && abs(lr) < 1000 && abs(lf) < 1000) {
        vr = vr + lr;
        vf = vf + lf;
        n = n + 1;
        if ((wd.downForceRaw ?? 0) > 0) grounded = true;
        if (wantAngle) {
          const p1 = obj.getNodePosition(wd.node1);
          const p2 = obj.getNodePosition(wd.node2);
          // spin axis
          const ax = p2.x - p1.x;
          const ay = p2.y - p1.y;
          const az = p2.z - p1.z;
          // rolling direction = up x axis (either sign), projected on the body's horizontal plane
          const qx = upY * az - upZ * ay;
          const qy = upZ * ax - upX * az;
          const qz = upX * ay - upY * ax;
          let f = qx * fwdX + qy * fwdY + qz * fwdZ;
          let r = qx * rgtX + qy * rgtY + qz * rgtZ;
          if (f < 0) {
            f = -f;
            r = -r;
          }
          const a = deg(atan2(r, f));
          if (a === a && abs(f) + abs(r) > 1e-9) {
            ang = ang + a;
            na = na + 1;
          }
        }
      }
    }
  }
  if (n > 0) {
    vr = vr / n;
    vf = vf / n;
  }
  if (na > 0) ang = ang / na;
  return $multi(vr, vf, n, ang, grounded);
}

let wheelbase = 2.5;
function updateGeometry(): void {
  let fz = 0;
  let nf = 0;
  let rz = 0;
  let nr = 0;
  for (const i of $range(1, frontWheels.length)) {
    const wd = frontWheels[i - 1]!;
    if (!wd.isBroken) {
      fz = fz + wheelFwdPos(wd);
      nf = nf + 1;
    }
  }
  for (const i of $range(1, rearWheels.length)) {
    const wd = rearWheels[i - 1]!;
    if (!wd.isBroken) {
      rz = rz + wheelFwdPos(wd);
      nr = nr + 1;
    }
  }
  if (nf > 0 && nr > 0) {
    const wb = abs(fz / nf - rz / nr);
    if (wb === wb && wb < 50) wheelbase = max(wb, 0.5);
  }
}

// ===== steering calibration ================================================================
function setUnsupported(msg: string): void {
  steer.unsupported = true;
  calibDone = true;
  guihooks.message("AGA Steering: " + msg + " - assist disabled for this vehicle", 6, "agaSteering");
  log("W", "agaSteering", msg + " - assist disabled for this vehicle");
}

/**
 * Standstill calibration: steps steering_input through calibInputs, waits for the (rate limited) steering hydros
 * to settle at each step and records the real front wheel angle. Also yields the sign convention and zero offset.
 * Returns the steering_input to write while calibrating, or nil when not calibrating.
 */
function updateCalibration(
  dt: number,
  speed: number,
  rawStick: number,
  throttle: number,
  frontAngle: number,
  rearAngle: number,
): number | undefined {
  if (calibDone || !cfg.calibrate) return undefined;
  if (calib === undefined) {
    // wait until the car has been sitting still with a centered stick for a moment (spawn drop, resets, ...)
    if (speed < 0.3 && abs(rawStick) < 0.05 && throttle < 0.1) calibStableT = calibStableT + dt;
    else calibStableT = 0;
    if (calibStableT < 1.0) return undefined;
    calib = { idx: 0, t: 0, settle: 0, ref: frontAngle, lp: frontAngle, samples: [], zeroF: 0, zeroR: 0 };
  }
  const c = calib;
  // abort (and retry later) if the player starts driving / steering. Never counts as a failure.
  if (speed > 1.0 || abs(rawStick) > 0.15 || throttle > 0.3) {
    const tgt = sweepAbortSeed(steer, c.idx);
    calib = undefined;
    calibStableT = 0;
    // continue smoothly from where the sweep left the wheels
    const s = steer.sign !== 0 ? steer.sign : 1;
    steeringSmoother.state = s * tgt;
    absSteeringSmoother.state = tgt;
    return undefined;
  }

  let target = c.idx === 0 ? 0 : calibInputs[c.idx - 1]!;
  // settle detection independent of frame rate: the (lightly filtered) angle must stay within a 0.1 deg band for 0.15 s
  c.t = c.t + dt;
  c.lp = c.lp + (frontAngle - c.lp) * min(1, dt / 0.04);
  if (abs(c.lp - c.ref) > 0.1) {
    c.ref = c.lp;
    c.settle = 0;
  } else {
    c.settle = c.settle + dt;
  }
  const minT = c.idx === 0 ? 0.4 : 0.2;
  if ((c.settle > 0.15 && c.t > minT) || c.t > 2.5) {
    if (c.idx === 0) {
      c.zeroF = c.lp;
      c.zeroR = rearAngle;
    } else {
      c.samples[c.idx - 1] = c.lp - c.zeroF;
    }
    if (c.idx === calibInputs.length) {
      const res = finishCalibration(steer, c.samples, rearAngle - c.zeroR);
      const zero = c.zeroF;
      calib = undefined;
      calibStableT = 0;
      if (res === "ok") {
        calibDone = true;
        steer.zeroDeg = zero;
        // wheels are at full lock right now: let the normal smoothing bring them back
        steeringSmoother.state = steer.sign;
        absSteeringSmoother.state = 1;
        guihooks.message(string.format("AGA Steering: calibrated (lock %.1f deg)", steer.lockDeg), 4, "agaSteering");
        log(
          "I",
          "agaSteering",
          string.format(
            "calibration lock=%.2f sign=%d zero=%.2f curve=%s",
            steer.lockDeg,
            steer.sign,
            steer.zeroDeg,
            dumps(steer.curveOut),
          ),
        );
      } else if (res === "rearsteer") {
        setUnsupported("rear-wheel steering detected");
      } else {
        calibFails = calibFails + 1;
        if (calibFails >= 2) {
          setUnsupported(
            res === "nosteer" ? "front wheels do not respond to steering" : "could not measure the steering lock",
          );
        } else {
          log("W", "agaSteering", "steering calibration failed (" + res + "), retrying");
        }
      }
      return 0;
    }
    c.idx = c.idx + 1;
    c.t = 0;
    c.settle = 0;
    target = calibInputs[c.idx - 1]!;
  }
  return target;
}

/**
 * Passive detection of the steering_input sign while driving (used until the calibration has run):
 * correlate what we commanded with what the front wheels actually did.
 */
function updateSignDetection(dt: number, frontAngle: number): void {
  if (abs(lastOut) > 0.15 && abs(frontAngle) > 2.0) {
    signEvidence = signEvidence + lastOut * frontAngle * dt;
  }
  signEvidence = signEvidence * (1 - min(1, dt / 5));
  if (abs(signEvidence) > 0.3) {
    steer.sign = sgn(signEvidence);
    log("I", "agaSteering", "steering direction detected while driving: sign=" + tostring(steer.sign));
  }
}

// ===== target front slip (learned) =========================================================
const assistedSurfaces: Readonly<Record<string, number | undefined>> = {
  METAL: 1,
  PLASTIC: 1,
  RUBBER: 1,
  GLASS: 1,
  WOOD: 1,
  ASPHALT: 1,
  ROCK: 1,
  RUMBLE_STRIP: 1,
  COBBLESTONE: 1,
};
let surfaceCache: LuaTable<number, number | undefined> | undefined = undefined;
const SURFACE_RETRY_SECONDS = 5;
/** the material table was readable and contained at least one assisted surface */
let surfaceCacheOk = false;
let surfaceRetryT = 0;
function buildSurfaceCache(): LuaTable<number, number | undefined> {
  const cache = new LuaTable<number, number | undefined>();
  surfaceCacheOk = false;
  const [ok, t] = pcall(() => particles.getMaterialsParticlesTable());
  if (ok && type(t) === "table") {
    for (const [k, mat] of pairs(t as LuaTable<number, { readonly name?: string } | undefined>)) {
      if (type(mat) === "table") {
        const assisted = assistedSurfaces[mat!.name as string];
        cache.set(k, assisted);
        if (assisted !== undefined) surfaceCacheOk = true;
      }
    }
  }
  surfaceCache = cache;
  return cache;
}
function isTarmac(matId: number | undefined): boolean {
  const cache = surfaceCache ?? buildSurfaceCache();
  return matId !== undefined && cache.get(matId) !== undefined;
}
/** The material table can be unavailable (or still empty) early on: keep retrying instead of never learning. */
function retrySurfaceCache(dt: number): void {
  if (surfaceCacheOk || surfaceCache === undefined) return;
  surfaceRetryT = surfaceRetryT + dt;
  if (surfaceRetryT >= SURFACE_RETRY_SECONDS) {
    surfaceRetryT = 0;
    buildSurfaceCache();
  }
}

const learn = newLearnState();
const learnFilters: LearnFilters = { lp: {}, stillT: 0 };
const frontAxle = newFrontAxleSample();

// learned tyre data persists per car model + tyre parts (settings/agaSteering_learned.json)
const LEARNED_PATH = "settings/agaSteering_learned.json";
interface LearnedEntry {
  C0: number;
  muMax: number;
  n: number;
}
let learnSaveT = 0;
let cachedLearnKey: string | undefined = undefined;
let lastSaved: LearnedEntry | undefined = undefined;
let saveWarned = false;

/** Tyre parts that identify the learned data: everything named *tire*, except spare tyres (they are not driven on). */
function isLearnKeyTyre(partName: string): boolean {
  if (string.find(partName, "tire", 1, true)[0] === undefined) return false;
  return string.find(string.lower(partName), "spare", 1, true)[0] === undefined;
}

function learnKey(): string | undefined {
  if (cachedLearnKey !== undefined) return cachedLearnKey;
  const c = v && v.config;
  if (!c) return undefined;
  const tyres: string[] = [];
  const seen: Record<string, boolean | undefined> = {};
  function walk(t: unknown, depth: number): void {
    if (type(t) !== "table" || depth > 40) return;
    const node = t as PartsTreeNode;
    const p = node.chosenPartName;
    if (typeof p === "string" && isLearnKeyTyre(p) && !seen[p]) {
      seen[p] = true;
      tyres.push(p);
    }
    for (const [, ch] of pairs(node)) {
      if (type(ch) === "table") walk(ch, depth + 1);
    }
  }
  walk(c.partsTree, 0);
  table.sort(tyres);
  cachedLearnKey = tostring(c.model ?? c.mainPartName ?? "?") + "|" + table.concat(tyres, ",");
  return cachedLearnKey;
}

function readLearned(): Record<string, unknown> {
  const [ok, t] = pcall(jsonReadFile, LEARNED_PATH);
  return ok && type(t) === "table" ? (t as Record<string, unknown>) : {};
}

function saveLearned(): void {
  if (!learn.dirty || !cfg.learnPeakSlip || cfg.peakSlipDeg > 0) return;
  const key = learnKey();
  const C0 = learn.C0;
  const muMax = learn.muMax;
  if (key === undefined || C0 === undefined || muMax === undefined) return;
  // skip writes that would change nothing meaningful
  if (
    lastSaved !== undefined &&
    abs(lastSaved.C0 - C0) < 0.01 * lastSaved.C0 &&
    abs(lastSaved.muMax - muMax) < 0.01 &&
    min(learn.n, 300) - lastSaved.n < 15
  ) {
    learn.dirty = false;
    return;
  }
  const all = readLearned(); // re-read right before writing: other cars may have saved meanwhile
  const entry: LearnedEntry = { C0: C0, muMax: muMax, n: min(learn.n, 300) };
  all[key] = entry;
  const [ok, res] = pcall(jsonWriteFile, LEARNED_PATH, all, true);
  if (ok && res !== false) {
    learn.dirty = false;
    lastSaved = entry;
  } else if (!saveWarned) {
    saveWarned = true;
    log("W", "agaSteering", "could not save learned tyre data to " + LEARNED_PATH + ": " + tostring(res));
  }
}

function restoreLearned(): void {
  if (!cfg.learnPeakSlip || cfg.peakSlipDeg > 0) return;
  const key = learnKey();
  if (key === undefined) return;
  const e = readLearned()[key] as { readonly C0?: unknown; readonly muMax?: unknown; readonly n?: unknown } | undefined;
  if (type(e) !== "table" || typeof e!.C0 !== "number" || typeof e!.muMax !== "number") return;
  const C0 = clamp(e!.C0, 1, 200);
  const muMax = clamp(e!.muMax, learn.muPrior * 0.8, 2.5);
  learn.C0 = C0;
  learn.muMax = muMax;
  learn.n = clamp(tonumber(e!.n) ?? 0, 0, 300);
  lastSaved = { C0: C0, muMax: muMax, n: learn.n };
  const est = peakSlipEstimateDeg(muMax, C0);
  targetSlipSmoother.state = lerp(learn.default, est, clamp01(learn.n / 300));
}

function resetLearning(): void {
  let mu = 1;
  const [ok, coef] = pcall(() => obj.getStaticFrictionCoef());
  if (ok && type(coef) === "number" && coef === coef) mu = coef as number;
  learn.muPrior = clamp(mu, 0.5, 1.8);
  learn.muMax = learn.muPrior;
  learn.cfgPeak = cfg.peakSlipDeg;
  learn.default = cfg.peakSlipDeg > 0 ? cfg.peakSlipDeg : clamp(11 - 3 * learn.muPrior, 5, 10);
  learn.C0 = (2.4 * learn.muPrior) / rad(learn.default);
  learn.n = 0;
  learn.lastFz = undefined;
  learn.mF = undefined;
  learn.mFn = 0;
  table.clear(learnFilters.lp);
  learnFilters.stillT = 0;
  targetSlipSmoother.state = learn.default;
  learn.dirty = false;
  restoreLearned();
}

function updateTargetSlip(dd: FrameData, dt: number): void {
  if (!cfg.learnPeakSlip) {
    targetSlipSmoother.state = learn.default;
    learn.why = 0;
    learn.dbg = undefined;
    return;
  }
  retrySurfaceCache(dt);
  let g = abs(nanGuard(obj.getGravity(), -9.81));
  if (g < 1) g = 9.81;
  sampleFrontAxle(frontAxle, frontWheels, dd, isTarmac);
  const ay = abs(nanGuard(sensors.gx2 ?? sensors.gx));
  const ax = abs(nanGuard(sensors.gy2 ?? sensors.gy));
  updateLearning(learn, learnFilters, targetSlipSmoother, dd, frontAxle, frontWheels.length, g, ay, ax, dt);
}

// ===== per-frame vehicle state =============================================================
const d = newFrameData();
const velLP: LowpassStates = {};
function gatherData(dt: number): FrameData | undefined {
  if (!updateFrame()) return undefined;
  let [fvx, fvz, nf, fAng, fGrounded] = axleState(frontWheels, true);
  let [rvx, rvz, nr, rAngSteer] = axleState(rearWheels, calib !== undefined);
  if (nf === 0 || nr === 0) return undefined;

  geomTimer = geomTimer - dt;
  if (geomTimer <= 0) {
    geomTimer = 1.0;
    updateGeometry();
  }

  if (cfg.velocitySmoothing > 0) {
    const tau = cfg.velocitySmoothing;
    fvx = lowpass(velLP, 1, fvx, dt, tau);
    fvz = lowpass(velLP, 2, fvz, dt, tau);
    rvx = lowpass(velLP, 3, rvx, dt, tau);
    rvz = lowpass(velLP, 4, rvz, dt, tau);
  }

  fillFrameData(d, fvx, fvz, rvx, rvz, wheelbase, fAng, rAngSteer, steer.zeroDeg);
  d.frontGrounded = groundedSmoother.get(fGrounded ? 1 : 0, dt);
  return d;
}

const steeringContext: SteeringContext = {
  cfg: cfg,
  d: d,
  steer: steer,
  selfSteerSmoother: selfSteerSmoother,
  counterIndicatorSmoother: counterIndicatorSmoother,
  limitSmoother: limitSmoother,
};

function resetState(): void {
  steeringSmoother.reset();
  absSteeringSmoother.reset();
  selfSteerSmoother.reset();
  limitSmoother.reset();
  groundedSmoother.reset();
  counterIndicatorSmoother.reset();
  table.clear(velLP);
  lastOut = 0;
}

// ===== hooks ===============================================================================
/** 0 = hands off, 1 = calibration allowed but no processing (e.g. no pad input seen yet), 2 = full processing */
function activeLevel(): 0 | 1 | 2 {
  if (!cfg.enabled || !ready || steer.unsupported) return 0;
  if (!humanDriving()) return 0;
  const st = input.state && input.state.steering;
  if (!st) return 0;
  const f = st.filter;
  if (f === undefined) return 0;
  if (f === FILTER_PAD) return 2;
  if (f === FILTER_KBD || f === FILTER_KBD2) return cfg.applyToKeyboard ? 2 : 1;
  return 0; // wheel (FILTER_DIRECT), AI or anything unknown
}

function writeSteering(value: number): void {
  lastOut = value;
  input.steering = value;
  electrics.values.steering_input = value;
}

function deactivate(): void {
  d.dbgFade = 0;
  d.dbgOut = 0;
  d.dbgStick = 0;
  if (lastFilterActive) resetState();
  lastFilterActive = false;
}

/** live status for the in-game UI app (read through the 'electrics' stream) */
function publishStatus(level: 0 | 1 | 2): void {
  const ev = electrics.values;
  ev.agaEnabled = cfg.enabled ? 1 : 0;
  ev.agaActive = level;
  ev.agaRally = cfg.rally ? 1 : 0;
  ev.agaCalibrated = steer.calibrated ? 1 : 0;
  ev.agaCalibrating = calib !== undefined ? 1 : 0;
  ev.agaUnsupported = steer.unsupported ? 1 : 0;
  ev.agaLockDeg = steer.lockDeg;
  ev.agaPeakSlip = targetSlipSmoother.state;
  ev.agaLearn = clamp01(learn.n / 300);
  ev.agaLearnWhy = learn.why ?? 0;
  // show what actually reaches the wheels: the assist fades out near standstill, where the velocity
  // angles are just noise, so blend the raw values by the same fade the steering uses
  const fade = level === 2 ? (d.dbgFade ?? 0) : 0;
  ev.agaLimit = 1 + (nanGuard(d.dbgLimit ?? 1, 1) - 1) * fade;
  ev.agaSelfSteer = nanGuard(d.dbgSelfSteer ?? 0, 0) * fade;
  // steering gauge for the UI app: everything normalized to the steering lock, positive = right
  const live = level === 2 && calib === undefined;
  ev.agaOut = live ? clamp(nanGuard(d.dbgOut ?? 0, 0), -1, 1) : 0;
  ev.agaStick = live ? clamp(nanGuard(d.dbgStick ?? 0, 0), -1, 1) : 0;
  ev.agaGrip = 1 + (clamp01(nanGuard(d.dbgGrip ?? 1, 1)) - 1) * fade;
  ev.agaMax = 1 + (clamp01(nanGuard(d.dbgMax ?? 1, 1)) - 1) * fade;
  ev.agaCounter = nanGuard(d.dbgCounter ?? 0, 0) * fade;
}

function updateGFX(dt: number | undefined): void {
  if (dt === undefined || !(dt > 0)) return;
  if (dt > 0.1) dt = 0.1; // hitches: keep the smoothers sane
  if (!ready) {
    publishStatus(0);
    // wheels could not be identified at load (e.g. node data not valid yet): retry occasionally for the player's vehicle
    if (!cfg.enabled || findTries >= 3 || !playerInfo.anyPlayerSeated) return;
    findTimer = findTimer + dt;
    if (findTimer < 2) return;
    findTimer = 0;
    findTries = findTries + 1;
    ready = findWheels();
    if (!ready) return;
  }
  const level = activeLevel();
  publishStatus(level);
  if (level === 0 || (level === 1 && (calibDone || !cfg.calibrate))) {
    calib = undefined;
    calibStableT = 0;
    deactivate();
    return;
  }

  const data = gatherData(dt);
  if (data === undefined) {
    // e.g. all front wheels gone: leave BeamNG's own steering alone
    calib = undefined;
    calibStableT = 0;
    deactivate();
    return;
  }

  // activeLevel() > 0 guarantees input.state.steering exists
  const rawStick = clamp(nanGuard(input.state!.steering!.val), -1, 1);

  // standstill calibration (briefly overrides steering after spawn)
  const throttle = abs(nanGuard(electrics.values.throttle_input ?? input.throttle));
  const calOverride = updateCalibration(dt, data.hVelLen, rawStick, throttle, data.rawSteerAngle, data.rearSteerAngle);
  if (calOverride !== undefined) {
    d.dbgFade = 0;
    writeSteering(calOverride);
    return;
  }
  if (steer.unsupported || level < 2) {
    deactivate();
    return;
  }

  // everything below works in the physical frame (positive = right)
  const signKnown = steer.sign !== 0;
  const s = signKnown ? steer.sign : 1;
  const stick = s * rawStick;
  lastFilterActive = true;

  const brake = clamp01(nanGuard(electrics.values.brake_input ?? input.brake));

  const steeringRateMult = calcSteeringRateMult(cfg, data.hVelLen, steer.lockDeg);
  let centeringRate = 1.0;
  if (steeringRateMult > 0.0 && steeringRateMult < 0.5) {
    const st = steeringSmoother.state;
    if ((abs(stick) < abs(st) && sgn(stick) === sgn(st)) || sgn(stick) !== sgn(st)) {
      centeringRate = (steeringRateMult * 0.5 + 0.25) / steeringRateMult;
    }
  }
  const initialSteering = steeringSmoother.getMult(stick, dt, steeringRateMult * centeringRate);
  const absInitialSteering = absSteeringSmoother.getMult(abs(stick), dt, steeringRateMult * centeringRate);

  if (!signKnown) {
    updateSignDetection(dt, data.steerAngle);
    steer.signRamp = 0;
  } else if (steer.signRamp < 1) {
    steer.signRamp = min(1, steer.signRamp + dt * 2);
  }

  updateTargetSlip(data, dt);
  learnSaveT = learnSaveT + dt;
  if (learnSaveT > 30) {
    learnSaveT = 0;
    saveLearned();
  }

  // no assist (plain smoothed stick) until we know which way steering_input turns the wheels
  const assistFadeIn =
    lerpInvSat(data.fAxleHVelLen, 2.0 * data.wheelbaseFactor, 6.0 * data.wheelbaseFactor) * steer.signRamp;
  const processed = calcCorrectedSteering(
    steeringContext,
    targetSlipSmoother.state,
    initialSteering,
    absInitialSteering,
    assistFadeIn,
    brake,
    dt,
  );
  const desired = lerp(initialSteering, processed, assistFadeIn);
  d.dbgFade = assistFadeIn;
  d.dbgOut = desired;
  d.dbgStick = stick;
  const out = s * clamp(nanGuard(normalizedSteeringToInput(steer, desired)), -1, 1);

  writeSteering(out);

  if (cfg.debug) {
    guihooks.graph(
      ["stick", rawStick, 1, ""],
      ["out", out, 1, ""],
      ["frontSlip", data.frontSlipDeg, 20, "deg"],
      ["targetSlip", targetSlipSmoother.state, 20, "deg"],
      ["limit", d.dbgLimit ?? 0, 1, ""],
      ["selfSteer", d.dbgSelfSteer ?? 0, 1, ""],
      ["counter", d.dbgCounter ?? 0, 1, ""],
    );
  }
}

function resetCalibrationState(): void {
  calib = undefined;
  calibDone = false;
  calibFails = 0;
  calibStableT = 0;
  steer.unsupported = false;
}

function init(): void {
  cachedLearnKey = undefined;
  lastSaved = undefined;
  loadConfig();
  detectXYZ();
  ready = findWheels();
  resetState();
  resetLearning();
  resetCalibrationState();
  steer.lockDeg = 35.0;
  steer.curveIn = [0.0, 1.0];
  steer.curveOut = [0.0, 1.0];
  steer.sign = 0;
  steer.zeroDeg = 0;
  steer.calibrated = false;
  steer.signRamp = 0;
  signEvidence = 0;
  geomTimer = 0;
  lastFilterActive = false;
  findTimer = 0;
  findTries = 0;
  if (!ready) {
    log("D", "agaSteering", "Could not identify front/rear wheels; assist inactive for this vehicle");
  } else if (wheelsByPosition) {
    log("I", "agaSteering", "No F*/R* wheel names; front/rear wheels identified by position");
  }
}

function onReset(): void {
  saveLearned();
  loadConfig();
  ready = findWheels(); // wheel tables may have been rebuilt; broken wheels are whole again
  resetState();
  lastFilterActive = false;
  // an interrupted sweep restarts; a finished calibration is kept
  calib = undefined;
  calibStableT = 0;
  geomTimer = 0;
  // keep what was learned about the tyres, but drop transient filter state (the car may have been teleported)
  table.clear(learnFilters.lp);
  learn.lastFz = undefined;
  learnFilters.stillT = 0;
  if (!cfg.learnPeakSlip || learn.cfgPeak !== cfg.peakSlipDeg) resetLearning();
}

function onSettingsChanged(): void {
  saveLearned(); // before a config change can reset the learned state
  loadConfig();
  if (learn.cfgPeak !== cfg.peakSlipDeg) resetLearning();
}

// ===== public interface (hook and API names are fixed by BeamNG / the UI app) ===============
export function onExtensionLoaded(): boolean {
  return true;
}
export function onExtensionUnloaded(): void {
  saveLearned();
}
export { saveLearned };
/** jbeam/wheels are ready here (auto extensions are loaded right before this hook) */
export const onVehicleLoaded = init;
export { onReset, updateGFX, onSettingsChanged };

// ===== mode API (v3.4) ======================================================================
// One source of truth: the car owns the mode ("off" | "grip" | "rally"), shows the message, saves it to the
// settings file and syncs every other spawned car. The UI app and the key bindings all call this.
// Console: be:getPlayerVehicle(0):queueLuaCommand("extensions.agaSteering.setMode('rally')")
type Mode = "off" | "grip" | "rally";
const MODE_TEXT: Readonly<Record<Mode, string>> = {
  off: "AGA OFF  -  stock BeamNG steering",
  grip: "AGA GRIP  -  steering stops at the grip limit",
  rally: "AGA RALLY  -  push the stick all the way to steer past the grip limit",
};

export function getMode(): Mode {
  if (!cfg.enabled) return "off";
  return cfg.rally ? "rally" : "grip";
}

/** quiet update, used to sync the other cars */
export function syncMode(en: unknown, rally: unknown): void {
  // Lua truthiness on purpose (called from generated Lua strings and the console)
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
  enabledOverride = en ? true : false;
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
  rallyOverride = rally ? true : false;
  cfg.enabled = enabledOverride;
  cfg.rally = rallyOverride;
}

export function setMode(mode: unknown, quiet?: boolean): void {
  if (mode !== "off" && mode !== "grip" && mode !== "rally") return;
  const en = mode !== "off";
  let rally = cfg.rally ? true : false;
  if (en) rally = mode === "rally";
  syncMode(en, rally);
  if (quiet !== true) guihooks.message(MODE_TEXT[mode], 3, "agaSteeringMode");
  const e = tostring(en);
  const r = tostring(rally);
  saveSettingsFromVehicle(
    CONFIG_PATH,
    { enabled: en, rally: rally },
    "local a=extensions.agaSteering if a and a.syncMode then a.syncMode(" + e + "," + r + ") end",
  );
}

export function setEnabled(b: unknown): void {
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
  setMode(b ? (cfg.rally ? "rally" : "grip") : "off");
}
export function toggle(): void {
  setEnabled(!cfg.enabled);
}
export function setRally(b: unknown): void {
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
  setMode(b ? "rally" : "grip");
}
/** View button: flips GRIP <-> RALLY (and switches the assist on if it was off) */
export function toggleRally(): void {
  setMode(cfg.enabled && cfg.rally ? "grip" : "rally");
}
export function syncRally(b: unknown): void {
  // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
  rallyOverride = b ? true : false;
  cfg.rally = rallyOverride;
}
/** called by the UI app after it saved slider changes; the live mode (overrides) is kept */
export function reloadConfig(): void {
  onSettingsChanged();
}
export function recalibrate(): void {
  resetCalibrationState();
}
export function getState() {
  return {
    lock: steer.lockDeg,
    curve: steer.curveOut,
    curveIn: steer.curveIn,
    sign: steer.sign,
    zero: steer.zeroDeg,
    calibrated: steer.calibrated,
    unsupported: steer.unsupported,
    wheelbase: wheelbase,
    wheelsByPosition: wheelsByPosition,
    ready: ready,
    targetSlip: targetSlipSmoother.state,
    learnSamples: learn.n,
    learnWhy: learn.why,
    learnDbg: learn.dbg,
    learnMuMax: learn.muMax,
    learnC0: learn.C0,
    frontStaticMass: learn.mF,
    cfg: cfg,
  };
}
