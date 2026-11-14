// Steering system model (measured) and the maths that turns a calibration sweep into it.
// All angles: positive = wheels pointing right.
import { clamp, interp, nanGuard, sgn } from "../core/mathx";

const abs = math.abs;
const min = math.min;

/** steering_input magnitudes visited by the standstill sweep. */
export const calibInputs: readonly number[] = [0.1, 0.2, 0.35, 0.5, 0.7, 1.0];

export interface SteerModel {
  /** steering lock in deg (35 is the fallback until calibrated) */
  lockDeg: number;
  /** |steering_input| break points */
  curveIn: number[];
  /** normalized |wheel angle| at those break points */
  curveOut: number[];
  /** +1: positive steering_input steers right, -1: left, 0: not known yet */
  sign: number;
  /** measured wheel angle at steering_input = 0 */
  zeroDeg: number;
  calibrated: boolean;
  /** front wheels don't steer (rear-steer / no steering): assist stays off */
  unsupported: boolean;
  /** fades the assist in once the sign is known */
  signRamp: number;
}

export function newSteerModel(): SteerModel {
  return {
    lockDeg: 35.0,
    curveIn: [0.0, 1.0],
    curveOut: [0.0, 1.0],
    sign: 0,
    zeroDeg: 0,
    calibrated: false,
    unsupported: false,
    signRamp: 0,
  };
}

export type CalibrationResult = "ok" | "nosteer" | "rearsteer" | "bad";

/**
 * samples[i] = signed front wheel angle (zero offset removed) at steering_input = calibInputs[i].
 * On "ok" the model's lock, curve and sign are replaced; otherwise the model is left untouched.
 */
export function finishCalibration(
  steer: SteerModel,
  samples: readonly (number | undefined)[],
  rearDelta: number | undefined,
): CalibrationResult {
  const lockSigned = samples[calibInputs.length - 1];
  if (lockSigned === undefined || lockSigned !== lockSigned) return "bad";
  const lockDeg = abs(lockSigned);
  if (lockDeg < 3) return abs(rearDelta ?? 0) > 3 ? "rearsteer" : "nosteer";
  if (lockDeg > 89) return "bad";
  const s = sgn(lockSigned);
  const ins = [0];
  const outs = [0];
  let prev = 0;
  for (let i = 0; i < calibInputs.length; i++) {
    let n = clamp((nanGuard(samples[i]) * s) / lockDeg, 0, 1);
    if (n <= prev + 1e-4) n = prev + 1e-4; // keep strictly monotonic so the inverse map is well defined
    ins.push(calibInputs[i]!);
    outs.push(min(n, 1));
    prev = n;
  }
  outs[outs.length - 1] = 1;
  steer.curveIn = ins;
  steer.curveOut = outs;
  steer.lockDeg = lockDeg;
  steer.sign = s;
  steer.calibrated = true;
  return "ok";
}

/** Steering curve: steering_input (-1..1) -> normalized wheel angle with the same sign. */
export function inputToNormalizedSteering(steer: Readonly<SteerModel>, u: number): number {
  return interp(steer.curveIn, steer.curveOut, u);
}

/**
 * Normalized wheel angle (magnitude) at which an interrupted sweep left the wheels: the sweep holds
 * steering_input = calibInputs[idx - 1] (idx 0 = still measuring the centre), and the smoothers that take over
 * work in normalized wheel angle, not in steering_input.
 */
export function sweepAbortSeed(steer: Readonly<SteerModel>, idx: number): number {
  return inputToNormalizedSteering(steer, calibInputs[idx - 1] ?? 0);
}

/** Inverse steering curve: normalized wheel angle (-1..1) -> |steering_input| with the same sign. */
export function normalizedSteeringToInput(steer: Readonly<SteerModel>, a: number): number {
  return interp(steer.curveOut, steer.curveIn, a);
}
