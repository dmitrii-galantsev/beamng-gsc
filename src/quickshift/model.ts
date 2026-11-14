/**
 * QuickShift decision model. Pure: no BeamNG API, only numbers in and numbers out, so it runs under Node unit tests
 * exactly as it runs in the game.
 *
 * Background (stock arcade shift logic, controller/vehicleController/shiftLogic/*.lua):
 *   - a downshift needs: gearChangeDelayTimer == 0, RPM below shiftDownAV (which falls with "driving aggression"),
 *     and |throttle - smoothedThrottle| < throttleUpShiftThreshold (0.05)
 *   - gamepad aggression is held for 2.25 s after lifting off, then decays to 0 => lazy downshift RPM
 *   - D -> R needs: smoothed brake > 0.1, smoothed throttle input == 0, smoothed avgAV <= 0.15 (electricMotor 0.5), neutral timer 0
 *   - R -> D needs: smoothed throttle input > 0, smoothed brake input == 0, smoothed avgAV > -1, neutral timer 0
 *   - avgAV is the smoothed gearbox / motor output shaft speed (rad/s), not the wheel speed
 */
import { isNum } from "../core/mathx";
import { applySettings, setSetting } from "../core/settings";

export interface NumConfig {
  /** driving aggression held while coasting / braking (0..1). 0.75 puts the downshift point about halfway between the lazy and sporty RPM */
  coastAggression: number;
  /** longest wait (s) between gear changes while coasting. Stock: ~0.5 */
  coastDelay: number;
  /** replaces the "throttle just moved" gate (stock 0.05) while coasting */
  coastGate: number;
  /** coast assist only above this speed (m/s) */
  coastMinSpeed: number;
  /** keep the aggression floor this long (s) after the throttle comes back, so the car does not upshift straight away */
  coastGrace: number;
  /** after a coast downshift keep the aggression floor this long (s), so the car does not upshift straight back: the
   *  downshift lands at a high RPM that the stock logic's normal (lower) upshift point would immediately reject */
  downshiftHold: number;
  /** wait (s) after a D/N/R change before the next one. Stock: 0.5 */
  neutralDelay: number;
  /** below this speed (m/s) the car counts as stopped for D -> R */
  stopSpeed: number;
  /** R -> D is allowed while still rolling backwards slower than this (m/s) */
  reverseToDriveMaxSpeed: number;
  /** a pedal must be held this long (s) before it triggers a reverse/drive change */
  holdTime: number;
}

export interface Config extends NumConfig {
  enabled: boolean;
  coastAssist: boolean;
  reverseAssist: boolean;
}

export const defaultConfig: Readonly<Config> = {
  enabled: true,
  coastAssist: true,
  reverseAssist: true,
  coastAggression: 0.75,
  coastDelay: 0.1,
  coastGate: 0.5,
  coastMinSpeed: 2,
  coastGrace: 0.5,
  downshiftHold: 1.5,
  neutralDelay: 0.1,
  stopSpeed: 0.7,
  reverseToDriveMaxSpeed: 3,
  holdTime: 0.05,
};

/** min, max of every numeric setting; values from the settings file are clamped into range */
export const ranges: Readonly<Record<keyof NumConfig, readonly [number, number]>> = {
  coastAggression: [0, 1],
  coastDelay: [0, 0.5],
  coastGate: [0.05, 1],
  coastMinSpeed: [0.5, 20],
  coastGrace: [0, 2],
  downshiftHold: [0, 5],
  neutralDelay: [0.02, 0.5],
  stopSpeed: [0.1, 3],
  reverseToDriveMaxSpeed: [0, 10],
  holdTime: [0, 0.5],
};

/** Resets `cfg` to the defaults, then applies whatever valid values `data` (parsed settings json, may be nil) holds. */
export function applyConfig(cfg: Config, data: unknown): void {
  applySettings(cfg, defaultConfig, ranges, data);
}

/** Live change of one setting (numbers are clamped). Returns false for an unknown name or a bad value. */
export function setOption(cfg: Config, name: unknown, value: unknown): boolean {
  return setSetting(cfg, defaultConfig, ranges, name, value);
}

/** Sets one numeric setting (clamped). Returns false for an unknown name or a bad value. */
export function setNumeric(cfg: Config, name: string, value: unknown): boolean {
  return isNum(value) && typeof defaultConfig[name as keyof Config] === "number" && setOption(cfg, name, value);
}

export interface State {
  throttleHeld: number;
  brakeHeld: number;
  /** seconds of aggression floor left after the coast ended */
  grace: number;
  /** seconds of aggression floor left after an assisted downshift */
  hold: number;
  /** gear seen last frame */
  lastGear: number;
}

export function newState(): State {
  return { throttleHeld: 0, brakeHeld: 0, grace: 0, hold: 0, lastGear: 0 };
}

export function resetState(s: State): void {
  s.throttleHeld = 0;
  s.brakeHeld = 0;
  s.grace = 0;
  s.hold = 0;
  s.lastGear = 0;
}

export interface Inputs {
  /** raw pedals, 0..1 */
  throttle: number;
  brake: number;
  /** m/s along the car's forward direction (negative = rolling backwards) */
  speed: number;
  /** the shift logic's current gear (currentGearIndex): < 0 reverse, 0 neutral / park, > 0 forward */
  gearIndex: number;
  /** the arcade behaviour is on: the logic picks D / N / R itself */
  arcade: boolean;
  /** the logic picks forward gears itself (arcade, or a D / S mode) */
  autoGear: boolean;
  /** smoothedValues.avgAV as the controller computed it (output shaft rad/s, negative = backwards), never our override */
  avgAV: number;
}

/** 0 = leave alone, 1 = toward R (pretend "stopped"), 2 = toward D (pretend "almost stopped") */
export type AvgMode = 0 | 1 | 2;

export interface Decision {
  coasting: boolean;
  /** driving aggression to hold, 0 = none */
  floor: number;
  /** cap for gearChangeDelayTimer in seconds, -1 = none */
  delayCap: number;
  /** throttle-change gate to use, -1 = stock */
  gate: number;
  avgMode: AvgMode;
  /** forbid upshifts for this frame (inside the hold after an assisted downshift, throttle not hard down) */
  blockUp: boolean;
}

export function newDecision(): Decision {
  return { coasting: false, floor: 0, delayCap: -1, gate: -1, avgMode: 0, blockUp: false };
}

/**
 * One frame of decisions. Writes into `out` (allocation-free when the caller passes its own) and returns it.
 *
 * The arcade D/N/R logic goes through N on the way: in R or D it drops to N as soon as |avgAV| < 5 and the smoothed
 * throttle is 0, and only from N does it pick the new direction. So each help must keep applying in N too, otherwise
 * the override puts the box in N and the next frame sees the real wheel speed again:
 *   1 (toward R): D, N, and R itself (keeps the brake pedal acting as reverse throttle while still creeping forward,
 *     so R does not bounce back to N)
 *   2 (toward D): R and N
 */
export function decide(c: Config, s: State, i: Inputs, dt: number, out: Decision = newDecision()): Decision {
  s.throttleHeld = i.throttle > 0.25 ? s.throttleHeld + dt : 0;
  s.brakeHeld = i.brake > 0.15 ? s.brakeHeld + dt : 0;

  const forwardRoll = c.coastAssist && i.autoGear && i.gearIndex > 1 && i.speed > c.coastMinSpeed;
  const coasting = forwardRoll && i.throttle < 0.05;
  if (coasting) {
    s.grace = c.coastGrace;
  } else {
    s.grace = math.max(s.grace - dt, 0);
  }
  // an assisted downshift (forward gear to a lower forward gear while coasting or just after) starts the hold
  if (i.gearIndex > 0 && s.lastGear > 0 && i.gearIndex < s.lastGear && (coasting || s.grace > 0)) s.hold = c.downshiftHold;
  else s.hold = math.max(s.hold - dt, 0);
  s.lastGear = i.gearIndex;
  const holdingGear = !coasting && forwardRoll && (s.grace > 0 || s.hold > 0) && (i.throttle < 0.6 || s.hold > 0);

  let avgMode: AvgMode = 0;
  if (c.reverseAssist && i.arcade) {
    if (i.gearIndex <= 1 && s.brakeHeld >= c.holdTime && i.throttle < 0.02 && math.abs(i.speed) < c.stopSpeed && i.avgAV > 0.1) {
      avgMode = 1;
    } else if (i.gearIndex <= 0 && s.throttleHeld >= c.holdTime && i.brake < 0.05 && i.speed > -c.reverseToDriveMaxSpeed && i.avgAV <= -1) {
      avgMode = 2;
    }
  }

  out.coasting = coasting;
  out.floor = coasting || holdingGear ? c.coastAggression : 0;
  out.delayCap = coasting ? c.coastDelay : -1;
  out.gate = coasting ? c.coastGate : -1;
  out.avgMode = avgMode;
  out.blockUp = forwardRoll && s.hold > 0 && i.throttle < 0.6;
  return out;
}

/** The wheel speed the shift logic should see for this frame. */
export function adjustedAvgAV(mode: AvgMode, avgAV: number): number {
  if (mode === 1) return math.min(avgAV, 0.1);
  if (mode === 2) return math.max(avgAV, -0.5);
  return avgAV;
}
