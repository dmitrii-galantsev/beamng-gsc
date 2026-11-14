// Main processing (AGA calcCorrectedSteering, BeamNG frame).
// Conventions: every lateral quantity is "positive = to the RIGHT of the car"
// (AC's local frame is x = left, so lateral angles are sign-flipped relative to the original source).
import type { SteerModel } from "./calibration";
import type { Config } from "./config";
import {
  clamp,
  clamp01,
  clampEased,
  inverseLerpClampedEased,
  lerp,
  lerpInvSat,
  nanGuard,
  sgn,
  signedPow,
} from "../core/mathx";
import type { Smooth } from "./smooth";

const abs = math.abs;
const min = math.min;
const max = math.max;
const sqrt = math.sqrt;
const atan2 = math.atan2;
const deg = math.deg;
const rad = math.rad;
const sin = math.sin;
const log10 = math.log10;

/** Per-frame vehicle state (one table, reused every frame). */
export interface FrameData {
  wheelbase: number;
  wheelbaseFactor: number;
  fVelRight: number;
  fVelFwd: number;
  rVelRight: number;
  rVelFwd: number;
  midVelFwd: number;
  /** horizontal speed at the average wheel position, m/s */
  hVelLen: number;
  fAxleHVelLen: number;
  /** deg, 0 = straight ahead; forced to 0 when (almost) stopped */
  travelDirection: number;
  /** rad/s, positive = rotating clockwise seen from above (nose to the right) */
  yawRateRight: number;
  /** 0..1 smoothed "any front wheel has load" */
  frontGrounded: number;
  /** front wheel angle as measured (used by calibration) */
  rawSteerAngle: number;
  rearSteerAngle: number;
  /** front wheel angle with the zero offset removed */
  steerAngle: number;
  /** velocity angles "corrected for reverse" exactly like AGA (positive = axle travelling to the right) */
  fAxleVelAngle: number;
  rAxleVelAngle: number;
  /** deg: wheel heading vs front axle travel direction (positive = wheel points right of travel) */
  frontSlipDeg: number;
  // diagnostics of the last processed frame
  dbgLimit?: number;
  dbgSelfSteer?: number;
  dbgCounter?: number;
  dbgFade?: number;
  /** grip limit and maximum reach (normalized to the lock) for the UI gauge */
  dbgGrip?: number;
  dbgMax?: number;
  /** last written wheel output and raw stick (normalized), for the UI gauge */
  dbgOut?: number;
  dbgStick?: number;
}

export function newFrameData(): FrameData {
  // The numeric fields are overwritten by fillFrameData() before anything reads them.
  return {
    wheelbase: 0,
    wheelbaseFactor: 0,
    fVelRight: 0,
    fVelFwd: 0,
    rVelRight: 0,
    rVelFwd: 0,
    midVelFwd: 0,
    hVelLen: 0,
    fAxleHVelLen: 0,
    travelDirection: 0,
    yawRateRight: 0,
    frontGrounded: 0,
    rawSteerAngle: 0,
    rearSteerAngle: 0,
    steerAngle: 0,
    fAxleVelAngle: 0,
    rAxleVelAngle: 0,
    frontSlipDeg: 0,
  };
}

/**
 * Derives the kinematic quantities from the axle velocities (body frame: right / forward, m/s) and the
 * measured wheel angles (deg). Does not touch frontGrounded or the dbg* fields.
 */
export function fillFrameData(
  d: FrameData,
  fvx: number,
  fvz: number,
  rvx: number,
  rvz: number,
  wheelbase: number,
  frontAngle: number,
  rearAngle: number,
  zeroDeg: number,
): void {
  d.wheelbase = wheelbase;
  d.wheelbaseFactor = wheelbase / 2.5;
  d.fVelRight = fvx;
  d.fVelFwd = fvz;
  d.rVelRight = rvx;
  d.rVelFwd = rvz;
  const mvx = (fvx + rvx) * 0.5; // velocity at the average wheel position (as AGA)
  const mvz = (fvz + rvz) * 0.5;
  d.midVelFwd = mvz;
  d.hVelLen = sqrt(mvx * mvx + mvz * mvz);
  d.fAxleHVelLen = sqrt(fvx * fvx + fvz * fvz);
  d.travelDirection = d.hVelLen > 0.5 ? nanGuard(deg(atan2(mvx, mvz))) : 0; // direction is noise when (almost) stopped
  d.yawRateRight = (fvx - rvx) / wheelbase;
  d.rawSteerAngle = frontAngle;
  d.rearSteerAngle = rearAngle;
  d.steerAngle = frontAngle - zeroDeg;
  d.fAxleVelAngle = nanGuard(deg(atan2(fvx, abs(fvz))));
  d.rAxleVelAngle = nanGuard(deg(atan2(rvx, abs(rvz))));
  d.frontSlipDeg = d.steerAngle - d.fAxleVelAngle;
}

/**
 * @param speed total horizontal speed in m/s. (The original AGA names this parameter "fwdVelClamped" but passes
 * vData.localHVelLen, i.e. the horizontal speed, so that is what is used here too.)
 */
export function calcSteeringRateMult(cfg: Readonly<Config>, speed: number, lockDeg: number): number {
  if (cfg.rally) return 1;
  const speedAdjustedRate = lockDeg / min(65.0 / (max(speed, 8.0) - 7.3) + 3.5, lockDeg);
  return speedAdjustedRate ** cfg.rateIncreaseWithSpeed * cfg.steeringRate;
}

/** Everything calcCorrectedSteering reads or updates besides its arguments. */
export interface SteeringContext {
  readonly cfg: Readonly<Config>;
  readonly d: FrameData;
  readonly steer: Readonly<SteerModel>;
  readonly selfSteerSmoother: Smooth;
  readonly counterIndicatorSmoother: Smooth;
  readonly limitSmoother: Smooth;
}

/**
 * All inputs/outputs are in the physical frame (positive = right), normalized to the steering lock.
 * Advances the three smoothers in `cx` and stores diagnostics in cx.d.dbg*.
 */
export function calcCorrectedSteering(
  cx: SteeringContext,
  targetFrontSlipDeg: number,
  initialSteering: number,
  absInitialSteering: number,
  assistFadeIn: number,
  brake: number,
  dt: number,
): number {
  const cfg = cx.cfg;
  const d = cx.d;
  const lock = cx.steer.lockDeg;
  // AGA's AC frame has x = left; here x = right, so fAng/rAng and the yaw rate are sign-flipped relative to the
  // original. Every use below is flipped accordingly (marked "AC: ...").
  const fAng = d.fAxleVelAngle;
  const rAng = d.rAxleVelAngle;
  const inputSign = sgn(initialSteering);
  const midSpeedFade = lerpInvSat(d.hVelLen, 10.0 * d.wheelbaseFactor, 20.0 * d.wheelbaseFactor);

  // self-steer: steer towards where the rear axle is travelling, plus yaw damping
  const correctionExponent = 1.0 + (1.0 - log10(10.0 * (cfg.selfSteerResponse * 0.9 + 0.1)));
  const correctionBase = (signedPow(clamp(rAng / 72.0, -1, 1), correctionExponent) * 72.0) / lock; // AC: -rAxleHVelAngle
  const selfSteerCap = clamp01(cfg.maxSelfSteerAngle / lock);
  const selfSteerStrength = max(1.0, d.frontGrounded) * assistFadeIn; // (sic) same as the original: not reduced while airborne
  let dampingForce = -d.yawRateRight * cfg.dampingStrength * 0.15 * (30.0 / lock); // AC: +localAngularVel.y
  if (cfg.reverseDampingFix) {
    // Travelling backwards, steering right yaws the car LEFT, so the original term would amplify yaw instead of
    // damping it. Flip it there; identical to AGA whenever the car travels within ~75 deg of its nose.
    dampingForce = dampingForce * clamp(d.midVelFwd / max(0.25 * d.hVelLen, 0.5), -1, 1);
  }
  const selfSteerCapT = min(1.0, 4.0 / (2.0 * selfSteerCap));
  const rawSelfSteer = clampEased(correctionBase, -selfSteerCap, selfSteerCap, selfSteerCapT) + dampingForce;
  const selfSteerForce = clamp(cx.selfSteerSmoother.get(nanGuard(rawSelfSteer), dt), -2.0, 2.0) * selfSteerStrength;

  // steering limit
  const finalTargetSlip = targetFrontSlipDeg * cfg.targetSlip;
  const maxLimitReduction = lerp(
    finalTargetSlip * 0.4,
    finalTargetSlip * 0.75,
    clamp01(cfg.maxDynamicLimitReduction / 10.0),
  );
  const angleSubLimit = lerp(maxLimitReduction, maxLimitReduction * 0.9, brake);
  // AC: inputSign * fAxleHVelAngle  (how far the front axle travels AWAY from the steered direction, deg)
  const clampedFAxleVelAngle = clampEased(
    -inputSign * fAng,
    -lock - 15.0,
    angleSubLimit,
    (angleSubLimit * 0.4) / (lock + 15.0 + angleSubLimit),
  );

  // AC: inputSign ~= sign(zeroGuard(rAxleLocalVel.x))  -> steering towards the side the rear axle is sliding to
  const isCountersteering = inputSign !== 0 && inputSign === sgn(d.rVelRight) && abs(initialSteering) > 1e-6;
  const rawCounterIndicator = isCountersteering ? inverseLerpClampedEased(4.5, 10.0, abs(rAng), 0.0, 1.0, 0.6) : 0.0;
  const returnRate = lerp(0.8, 0.3, lerpInvSat(abs(fAng - rAng), 2.0, 10.0));
  const counterIndicator =
    cx.counterIndicatorSmoother.getMult(
      rawCounterIndicator,
      dt,
      rawCounterIndicator < cx.counterIndicatorSmoother.state ? returnRate : 1.0,
    ) * midSpeedFade;

  const antiSelfSteer = absInitialSteering * -selfSteerForce;
  const targetInward = finalTargetSlip - clampedFAxleVelAngle;
  const counterMult = lerp(
    lerpInvSat(inputSign * rAng, 0.0, 30.0) * (1.0 / 3.0) + 2.0 / 3.0,
    1.0,
    cfg.countersteerResponse,
  ); // AC: -inputSign * rAng
  const targetCounter = finalTargetSlip * (cfg.countersteerResponse * counterMult * 0.7 + 0.1) + inputSign * rAng; // AC: - (inputSign * rAng)

  const targetSteeringAngle = lerp(clamp(targetInward, 0, lock), clamp(targetCounter, 0, lock), counterIndicator);
  const notForward = sin(clamp(rad((d.travelDirection * 2.0) / 3.0), -math.pi * 0.5, math.pi * 0.5)) ** 16;
  const smoothLimit = cx.limitSmoother.get(nanGuard(targetSteeringAngle, lock), dt);
  const limit = lerp(smoothLimit / lock, 1.0, notForward);
  d.dbgGrip = clamp01(limit);

  if (cfg.rally) {
    // Rally v3. The stick has two zones:
    //   * 0 .. knee: sweeps 0 .. the grip limit (same limit as grip mode, so fine control at speed is kept)
    //   * knee .. 1: adds angle PAST the grip limit. How much is speed dependent: everything up to full lock
    //     when slow (hairpins), tapering to cfg.rallyExtraDeg above ~125 km/h so the top of the stick stays
    //     usable at speed instead of snapping to full lock.
    // The curve's slope is continuous at the knee (no dead spot, no sudden jump in sensitivity).
    // Self-steer / yaw damping stay strong for small inputs and fade out as the stick nears the knee; they come
    // back when the stick is released, which straightens the car.
    const knee = cfg.rallyKnee;
    const g = clamp(limit, 0.05, 1);
    const mag = abs(initialSteering);
    let fast = lerpInvSat(d.hVelLen, 10, 35);
    fast = fast * fast * (3 - 2 * fast);
    const room = 1 - g;
    const extra = lerp(room, min(room, cfg.rallyExtraDeg / lock), fast);
    const t = clamp01((mag - knee) / (1 - knee));
    const a = extra > 0.000001 ? clamp((g * (1 - knee)) / (knee * extra), 0.15, 1) : 1;
    const base = g * min(mag / knee, 1) + extra * (a * t + (1 - a) * t * t);
    const hold = clamp01(absInitialSteering / knee);
    const rallySelf = selfSteerForce * (1 - hold * hold);
    d.dbgLimit = g;
    d.dbgGrip = g;
    d.dbgMax = g + extra;
    d.dbgSelfSteer = rallySelf;
    d.dbgCounter = counterIndicator;
    return clamp(inputSign * base + rallySelf, -1, 1);
  }

  d.dbgLimit = limit;
  d.dbgMax = clamp01(limit);
  d.dbgSelfSteer = selfSteerForce;
  d.dbgCounter = counterIndicator;

  return clamp(initialSteering * limit + selfSteerForce + antiSelfSteer, -1.0, 1.0);
}
