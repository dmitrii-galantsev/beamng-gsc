// Target front slip (learned).
// BeamNG exposes no normalized tyre slip, so instead of AC's ndSlip trick we estimate the peak
// slip angle from the front axle's sub-limit cornering stiffness:  alphaPeak ~= 2.4 * muMax / C0
// (C0 = slope of normalized front lateral force vs slip angle). Only sampled in clean, steady, forward cornering
// on tarmac-like surfaces; blended in by confidence and rate-limited.
import { clamp, clamp01, lerp, lowpass, nanGuard, sgn } from "../core/mathx";
import type { LowpassStates } from "../core/mathx";
import type { Smooth } from "./smooth";

const abs = math.abs;
const min = math.min;
const max = math.max;
const deg = math.deg;
const rad = math.rad;
const huge = math.huge;

export interface LearnDebug {
  ayS: number;
  ayKin: number;
  alphaDeg: number;
  muF?: number;
}

export interface LearnState {
  /** static front axle mass (kg), averaged while standing still */
  mF: number | undefined;
  mFn: number;
  /** cornering stiffness estimate (normalized lateral force per rad). nil only before the first vehicle load. */
  C0: number | undefined;
  /** highest front friction usage seen. nil only before the first vehicle load. */
  muMax: number | undefined;
  muPrior: number;
  /** confidence counter (60 per second of accepted samples, capped) */
  n: number;
  lastFz: number | undefined;
  /** peak slip (deg) used until something was learned */
  default: number;
  /** cfg.peakSlipDeg the state was reset with */
  cfgPeak: number | undefined;
  /** something changed that is worth persisting */
  dirty?: boolean;
  /** bit flags: which gate rejected the last sample (published as electrics.agaLearnWhy) */
  why?: number;
  dbg?: LearnDebug;
}

export function newLearnState(): LearnState {
  return {
    mF: undefined,
    mFn: 0,
    C0: undefined,
    muMax: undefined,
    muPrior: 1,
    n: 0,
    lastFz: undefined,
    default: 8,
    cfgPeak: undefined,
  };
}

/** Transient estimator state that is dropped on every vehicle reset. */
export interface LearnFilters {
  /** low-pass states "fz", "ay", "al", "yawA" plus "lastYaw" */
  lp: LowpassStates;
  /** seconds the car has been (nearly) stationary */
  stillT: number;
}

/** `why` bit flags. */
export const enum Why {
  NoStaticMass = 1,
  TooSlow = 2,
  NotForward = 4,
  WheelSlip = 8,
  Accelerating = 16,
  YawAccel = 32,
  UnloadedWheel = 64,
  Surface = 128,
  NotTurningSame = 256,
  Drifting = 512,
  Kerb = 1024,
  AccelMismatch = 2048,
  SlipOutOfBand = 4096,
  NearLimit = 8192,
}

/** What the estimator needs to know about the front axle in this frame. */
export interface FrontAxleSample {
  /** total vertical load, N */
  FzF: number;
  /** smallest single wheel load, N */
  minFz: number;
  /** all front wheels present and on the same tarmac-like material */
  sameMat: boolean;
  /** no wheel spins/locks by more than 10 % */
  slipRatioOk: boolean;
  /** intact wheel count */
  nFront: number;
}

export function newFrontAxleSample(): FrontAxleSample {
  return { FzF: 0, minFz: huge, sameMat: true, slipRatioOk: true, nFront: 0 };
}

/** The part of the per-frame vehicle data the estimator reads. */
export interface LearnKinematics {
  readonly hVelLen: number;
  readonly fAxleHVelLen: number;
  readonly fVelFwd: number;
  readonly rVelFwd: number;
  readonly yawRateRight: number;
  readonly frontSlipDeg: number;
  readonly rAxleVelAngle: number;
}

/** Front vertical load (handles aero + load transfer), surface and wheel-slip checks. Fills `out`. */
export function sampleFrontAxle(
  out: FrontAxleSample,
  frontWheels: readonly WheelData[],
  dd: LearnKinematics,
  isTarmac: (this: void, matId: number | undefined) => boolean,
): void {
  let FzF = 0;
  let minFz = huge;
  let sameMat = true;
  let firstMat: number | undefined = undefined;
  let slipRatioOk = true;
  let nFront = 0;
  for (let i = 0; i < frontWheels.length; i++) {
    const wd = frontWheels[i]!;
    if (!wd.isBroken) {
      const fz = nanGuard(wd.downForceRaw);
      FzF = FzF + fz;
      minFz = min(minFz, fz);
      nFront = nFront + 1;
      let mat = wd.contactMaterialID1;
      if (mat === 4) mat = wd.contactMaterialID2;
      firstMat = firstMat ?? mat;
      if (mat !== firstMat || !isTarmac(mat)) sameMat = false;
      const ws = wd.wheelSpeed;
      if (ws !== undefined && dd.fAxleHVelLen > 1 && abs(ws - dd.fVelFwd) / dd.fAxleHVelLen > 0.1) {
        slipRatioOk = false;
      }
    }
  }
  if (nFront < frontWheels.length) sameMat = false; // never learn with a missing front wheel
  out.FzF = FzF;
  out.minFz = minFz;
  out.sameMat = sameMat;
  out.slipRatioOk = slipRatioOk;
  out.nFront = nFront;
}

/** Peak slip angle estimate in deg from the learned stiffness and friction, limited to 4..14 deg. */
export function peakSlipEstimateDeg(muMax: number, C0: number): number {
  return deg(clamp((2.4 * muMax) / max(C0, 1e-3), rad(4), rad(14)));
}

/**
 * One estimator step. Updates `learn`, `filt` and the target slip held in `targetSlip.state`.
 *
 * @param nFrontWheels number of front wheels the car has (intact or not)
 * @param g  gravity magnitude, m/s^2
 * @param ay |lateral acceleration|, m/s^2
 * @param ax |longitudinal acceleration|, m/s^2
 */
export function updateLearning(
  learn: LearnState,
  filt: LearnFilters,
  targetSlip: Smooth,
  dd: LearnKinematics,
  axle: Readonly<FrontAxleSample>,
  nFrontWheels: number,
  g: number,
  ay: number,
  ax: number,
  dt: number,
): void {
  const FzF = axle.FzF;
  const lpState = filt.lp;

  // static front mass: sampled while (nearly) stationary, settled and not accelerating
  if (dd.hVelLen < 3 && ax < 0.5 && ay < 0.5) filt.stillT = filt.stillT + dt;
  else filt.stillT = 0;
  if (filt.stillT > 0.5 && FzF > 0 && axle.nFront === nFrontWheels) {
    learn.mFn = min(learn.mFn + 1, 600);
    learn.mF = (learn.mF ?? FzF / g) + (FzF / g - (learn.mF ?? FzF / g)) / learn.mFn;
  }
  const mF = learn.mF;
  if (mF === undefined || FzF <= 0) {
    learn.why = Why.NoStaticMass;
    return;
  }

  const FzS = lowpass(lpState, "fz", FzF, dt, 0.03);
  const ayS = lowpass(lpState, "ay", ay, dt, 0.03);
  const alpha = lowpass(lpState, "al", abs(rad(dd.frontSlipDeg)), dt, 0.03);
  let yawA = (dd.yawRateRight - (lpState.lastYaw ?? dd.yawRateRight)) / dt;
  lpState.lastYaw = dd.yawRateRight;
  yawA = lowpass(lpState, "yawA", yawA, dt, 0.03);

  const lastFz = learn.lastFz;
  const kerb = lastFz !== undefined && lastFz > 0 && abs(FzF - lastFz) / lastFz > 0.3 * (dt / 0.1);
  learn.lastFz = FzF;

  const staticPerWheel = (mF * g) / max(nFrontWheels, 1);
  const turningSame = sgn(dd.frontSlipDeg) === sgn(dd.yawRateRight);
  const notDrifting = abs(dd.rAxleVelAngle) < abs(dd.frontSlipDeg);
  // the accelerometer must agree with the kinematic lateral acceleration (yaw rate * speed): rejects transients,
  // banking, and protects the estimator should the sensor ever report in other units
  const ayKin = abs(dd.yawRateRight) * dd.hVelLen;
  const accelOk = abs(ayS - ayKin) < 0.45 * max(ayS, ayKin) + 0.6;
  const gate =
    dd.hVelLen > 8 &&
    dd.fVelFwd > 0 &&
    dd.rVelFwd > 0 &&
    axle.slipRatioOk &&
    ax < 3 &&
    abs(yawA) < 1.2 &&
    axle.minFz > 0.25 * staticPerWheel &&
    axle.sameMat &&
    turningSame &&
    notDrifting &&
    !kerb &&
    accelOk;

  // diagnostics: which gate is closing (bit flags, published as electrics.agaLearnWhy)
  let why = 0;
  if (!(dd.hVelLen > 8)) why = why + Why.TooSlow;
  if (!(dd.fVelFwd > 0 && dd.rVelFwd > 0)) why = why + Why.NotForward;
  if (!axle.slipRatioOk) why = why + Why.WheelSlip;
  if (!(ax < 3)) why = why + Why.Accelerating;
  if (!(abs(yawA) < 1.2)) why = why + Why.YawAccel;
  if (!(axle.minFz > 0.25 * staticPerWheel)) why = why + Why.UnloadedWheel;
  if (!axle.sameMat) why = why + Why.Surface;
  if (!turningSame) why = why + Why.NotTurningSame;
  if (!notDrifting) why = why + Why.Drifting;
  if (kerb) why = why + Why.Kerb;
  if (!accelOk) why = why + Why.AccelMismatch;
  let dbg = learn.dbg;
  if (dbg === undefined) {
    dbg = { ayS: 0, ayKin: 0, alphaDeg: 0 };
    learn.dbg = dbg;
  }
  dbg.ayS = ayS;
  dbg.ayKin = ayKin;
  dbg.alphaDeg = deg(alpha);

  // C0 / muMax are always set once a vehicle has been loaded (resetLearning), and nothing gets here before that.
  let C0 = learn.C0!;
  let muMax = learn.muMax!;
  if (gate) {
    const muF = (mF * ayS) / FzS;
    dbg.muF = muF;
    if (!(alpha > rad(0.4) && alpha < rad(0.6 * targetSlip.state))) why = why + Why.SlipOutOfBand;
    if (!(muF < 0.6 * muMax)) why = why + Why.NearLimit;
    if (alpha > rad(0.4) && alpha < rad(0.6 * targetSlip.state) && muF < 0.6 * muMax) {
      C0 = C0 + (muF / alpha - C0) * min(1, dt / 2.0);
      learn.C0 = C0;
      learn.n = min(learn.n + dt * 60, 600);
      learn.dirty = true;
    }
    if (muF > muMax) muMax = muMax + (muF - muMax) * min(1, dt / 0.3);
    else muMax = muMax + (learn.muPrior - muMax) * min(1, dt / 60);
    muMax = clamp(muMax, learn.muPrior * 0.8, 2.5);
    learn.muMax = muMax;
  }

  learn.why = why;
  const est = peakSlipEstimateDeg(muMax, C0);
  const target = lerp(learn.default, est, clamp01(learn.n / 300));
  const cur = targetSlip.state;
  targetSlip.state = cur + clamp(target - cur, -1.0 * dt, 1.0 * dt); // 1 deg/s max
}
