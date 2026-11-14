// Deterministic number vectors computed from the pure modules. This very file runs twice on every `npm test`:
// natively under Node (through the `math` shim the unit tests use) and, compiled by TypeScriptToLua, under LuaJIT.
// parity.test.ts compares the two - evidence that what the unit tests check under Node holds for the Lua that ships.
// Restrictions: pure-module rules apply (no JS library calls, no Lua library calls except `math`).
import { calibInputs, finishCalibration, newSteerModel, normalizedSteeringToInput } from "../../src/aga/calibration";
import { applyConfig } from "../../src/aga/config";
import type { Config } from "../../src/aga/config";
import { newFrontAxleSample, newLearnState, peakSlipEstimateDeg, sampleFrontAxle, updateLearning } from "../../src/aga/learn";
import type { LearnFilters } from "../../src/aga/learn";
import {
  clamp,
  clamp01,
  clampEased,
  interp,
  inverseLerp,
  inverseLerpClampedEased,
  lerp,
  lerpInvSat,
  lowpass,
  nanGuard,
  sgn,
  signedPow,
} from "../../src/core/mathx";
import type { LowpassStates } from "../../src/core/mathx";
import { Smooth } from "../../src/aga/smooth";
import { calcCorrectedSteering, calcSteeringRateMult, fillFrameData, newFrameData } from "../../src/aga/steering";
import type { SteeringContext } from "../../src/aga/steering";

export function computeVectors(): number[] {
  const out: number[] = [];
  // Park-Miller generator: exact in doubles, so both runtimes see identical inputs
  let seed = 20231111;
  const rnd = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const sym = (scale: number): number => (rnd() * 2 - 1) * scale;
  const flag = (b: boolean): number => (b ? 1 : 0);

  // --- scalar helpers ---------------------------------------------------------------------------------------
  for (let i = 0; i < 300; i++) {
    const x = sym(3);
    const a = sym(2);
    const b = sym(2);
    const t = rnd();
    out.push(clamp(x, -1, 1), clamp01(x), sgn(x), lerp(a, b, t), lerpInvSat(x, a, b), inverseLerp(a, b, x));
    out.push(signedPow(x, 0.5 + 2 * t), clampEased(x, -1 - t, 1 + t, t), clampEased(x, a - 3, a + 3, 0.1 * t));
    out.push(inverseLerpClampedEased(4.5, 10.0, x * 5, 0.0, 1.0, 0.6));
  }
  out.push(nanGuard(undefined), nanGuard(undefined, 5), nanGuard(0 / 0, 6), nanGuard(math.huge, 7), nanGuard(-math.huge), nanGuard(1.25, 9));
  out.push(sgn(0), sgn(0 / 0), clamp(0 / 0, 0, 1) === 0 ? 1 : 0, lerpInvSat(1, 2, 2), inverseLerp(2, 2, 1), signedPow(0, 0.3));

  // --- interpolation ----------------------------------------------------------------------------------------
  const xs = [0, 0.1, 0.2, 0.35, 0.5, 0.7, 1.0];
  const ys = [0, 0.071, 0.157, 0.299, 0.451, 0.664, 1.0];
  for (let i = 0; i < 200; i++) {
    const x = sym(1.3);
    out.push(interp(xs, ys, x), interp(ys, xs, x));
  }

  // --- low-pass and smoothers --------------------------------------------------------------------------------
  const lp: LowpassStates = {};
  const smoothers = [
    new Smooth(7.0, 0.13, -1, 1, 0),
    new Smooth(11.0, 0.01, 0, 32, 32),
    new Smooth(4.0, 1.0, 0, 1, 1),
    new Smooth(12.0, 1.0, 0, 1, 0),
    new Smooth(0.12, 0.05, 0, 15, 7),
  ];
  let target = 0;
  for (let i = 0; i < 1500; i++) {
    if (i % 50 === 0) target = rnd();
    const dt = 0.002 + rnd() * 0.05;
    out.push(lowpass(lp, "a", target, dt, 0.03), lowpass(lp, 1, target * 2, dt, 0.2));
    out.push(smoothers[0]!.get(target * 2 - 1, dt), smoothers[1]!.get(target * 32, dt), smoothers[2]!.get(target, dt));
    out.push(smoothers[3]!.getMult(target, dt, 0.3 + rnd()), smoothers[4]!.get(target * 15, dt, rnd()));
  }
  smoothers[1]!.reset();
  out.push(smoothers[1]!.state);

  // --- configuration -----------------------------------------------------------------------------------------
  const pushConfig = (cfg: Config): void => {
    out.push(flag(cfg.enabled), flag(cfg.applyToKeyboard), cfg.steeringRate, cfg.filterSetting, flag(cfg.useFilter));
    out.push(cfg.targetSlip, cfg.maxSelfSteerAngle, cfg.rateIncreaseWithSpeed, cfg.selfSteerResponse, cfg.dampingStrength);
    out.push(cfg.countersteerResponse, cfg.maxDynamicLimitReduction, cfg.peakSlipDeg, flag(cfg.learnPeakSlip));
    out.push(flag(cfg.calibrate), flag(cfg.reverseDampingFix), cfg.velocitySmoothing, flag(cfg.debug));
  };
  const cfg = {} as Config;
  applyConfig(cfg, undefined, undefined);
  pushConfig(cfg);
  const files: unknown[] = [
    {},
    "nonsense",
    7,
    { filterSetting: 0.83, steeringRate: 0.31 },
    { filterSetting: 5, steeringRate: -1, peakSlipDeg: 99, velocitySmoothing: 1 },
    { useFilter: false, selfSteerResponse: 0.8, dampingStrength: 0.1, countersteerResponse: 0.9, targetSlip: 1.2, maxSelfSteerAngle: 45 },
    { enabled: false, debug: true, calibrate: false, learnPeakSlip: false, reverseDampingFix: false, applyToKeyboard: true },
    { enabled: 1, debug: "yes", steeringRate: "fast", targetSlip: 0 / 0, unknownKey: 3, useFilter: 0 },
  ];
  for (let i = 0; i < files.length; i++) {
    applyConfig(cfg, files[i], undefined);
    pushConfig(cfg);
    applyConfig(cfg, files[i], i % 2 === 0);
    out.push(flag(cfg.enabled));
  }

  // --- calibration -------------------------------------------------------------------------------------------
  const resultCode = (r: string): number => (r === "ok" ? 0 : r === "nosteer" ? 1 : r === "rearsteer" ? 2 : 3);
  for (let k = 0; k < 40; k++) {
    const lock = k < 30 ? 3 + rnd() * 60 : k < 35 ? rnd() * 3 : 89 + rnd() * 5;
    const expo = 0.7 + rnd() * 0.8;
    const dir = rnd() < 0.5 ? -1 : 1;
    const samples: number[] = [];
    for (let i = 0; i < calibInputs.length; i++) samples.push(dir * lock * calibInputs[i]! ** expo + sym(0.05));
    const model = newSteerModel();
    out.push(resultCode(finishCalibration(model, samples, sym(6))));
    out.push(model.lockDeg, model.sign, flag(model.calibrated), model.curveIn.length, model.curveOut.length);
    for (let i = 0; i < model.curveOut.length; i++) out.push(model.curveIn[i]!, model.curveOut[i]!);
    for (let i = 0; i < 10; i++) out.push(normalizedSteeringToInput(model, sym(1.1)));
  }

  // --- steering core -----------------------------------------------------------------------------------------
  for (let variant = 0; variant < 4; variant++) {
    applyConfig(
      cfg,
      variant === 0
        ? {}
        : variant === 1
          ? { filterSetting: 0.9, steeringRate: 0.8 }
          : variant === 2
            ? { useFilter: false, maxSelfSteerAngle: 20, reverseDampingFix: false, rateIncreaseWithSpeed: 0.3 }
            : { filterSetting: 0.1, steeringRate: 0.2 },
      undefined,
    );
    const steer = newSteerModel();
    steer.lockDeg = 22 + variant * 7;
    const cx: SteeringContext = {
      cfg: cfg,
      d: newFrameData(),
      steer: steer,
      selfSteerSmoother: new Smooth(7.0, 0.13, -1, 1, 0),
      counterIndicatorSmoother: new Smooth(12.0, 1.0, 0, 1, 0),
      limitSmoother: new Smooth(11.0, 0.01, 0, 32, 32),
    };
    const d = cx.d;
    let stick = 0;
    for (let i = 0; i < 1500; i++) {
      if (i % 25 === 0) {
        const reverse = rnd() < 0.15;
        const speed = rnd() * 50 * (reverse ? -0.3 : 1);
        const fvx = sym(8);
        const rvx = rnd() < 0.5 ? fvx + sym(1.5) : sym(12);
        fillFrameData(d, fvx, speed + sym(0.5), rvx, speed + sym(0.5), 2.2 + variant * 0.3, sym(25), sym(1), sym(0.5));
        d.frontGrounded = rnd();
        stick = rnd() < 0.3 ? 0 : sym(1);
        out.push(d.hVelLen, d.fAxleHVelLen, d.travelDirection, d.yawRateRight, d.steerAngle, d.fAxleVelAngle);
        out.push(d.rAxleVelAngle, d.frontSlipDeg, d.midVelFwd, d.wheelbaseFactor);
        out.push(calcSteeringRateMult(cfg, d.hVelLen, steer.lockDeg));
      }
      const dt = i % 7 === 0 ? 1 / 30 : 1 / 60;
      const res = calcCorrectedSteering(cx, 5 + variant * 2, stick, math.abs(stick), clamp01(d.fAxleHVelLen / 6), rnd() < 0.2 ? rnd() : 0, dt);
      out.push(res, d.dbgLimit!, d.dbgSelfSteer!, d.dbgCounter!);
    }
  }

  // --- peak slip estimator -----------------------------------------------------------------------------------
  const isTarmac = (m: number | undefined): boolean => m === 10;
  for (let peak = 5; peak <= 11; peak += 3) {
    const learn = newLearnState();
    learn.muPrior = 1;
    learn.muMax = 1;
    learn.default = 8;
    learn.C0 = 2.4 / math.rad(8);
    const filt: LearnFilters = { lp: {}, stillT: 0 };
    const slip = new Smooth(0.12, 0.05, 0, 15, 7);
    slip.state = 8;
    const axle = newFrontAxleSample();
    const C = 2.4 / math.rad(peak);
    const g = 9.81;
    const d = newFrameData();
    const wheelsF: { downForceRaw: number; contactMaterialID1: number; contactMaterialID2: number; wheelSpeed: number; isBroken: boolean }[] =
      [
        { downForceRaw: 3400, contactMaterialID1: 10, contactMaterialID2: 10, wheelSpeed: 0, isBroken: false },
        { downForceRaw: 3400, contactMaterialID1: 10, contactMaterialID2: 10, wheelSpeed: 0, isBroken: false },
      ];
    let speed = 0;
    let slipDeg = 0;
    for (let i = 0; i < 4000; i++) {
      if (i === 150) speed = 22;
      if (i >= 150 && i % 200 === 0) {
        slipDeg = sym(0.3 * peak);
        wheelsF[0]!.contactMaterialID1 = rnd() < 0.1 ? 11 : rnd() < 0.1 ? 4 : 10;
        wheelsF[1]!.isBroken = rnd() < 0.05;
      }
      const noise = i >= 150 ? sym(0.02) : 0;
      const ay = C * math.rad(slipDeg + noise) * g;
      const yaw = speed > 0 ? ay / speed : 0;
      const fvx = speed > 0 ? yaw * 2.6 : 0;
      const velAngle = math.deg(math.atan2(fvx, math.abs(speed)));
      fillFrameData(d, fvx, speed, 0, speed, 2.6, velAngle + slipDeg + noise, 0, 0);
      const transfer = 600 * (ay / g);
      wheelsF[0]!.downForceRaw = 3400 + transfer;
      wheelsF[1]!.downForceRaw = 3400 - transfer;
      wheelsF[0]!.wheelSpeed = speed * (rnd() < 0.02 ? 1.3 : 1);
      wheelsF[1]!.wheelSpeed = speed;
      sampleFrontAxle(axle, wheelsF, d, isTarmac);
      updateLearning(learn, filt, slip, d, axle, 2, g, math.abs(ay), rnd() < 0.03 ? 4 : 0, i % 5 === 0 ? 1 / 45 : 1 / 60);
      if (i % 10 === 0) {
        out.push(slip.state, learn.C0!, learn.muMax!, learn.n, learn.why ?? -1, learn.mF ?? -1, learn.mFn, filt.stillT);
        out.push(axle.FzF, axle.minFz === math.huge ? -1 : axle.minFz, flag(axle.sameMat), flag(axle.slipRatioOk), axle.nFront);
      }
    }
    out.push(peakSlipEstimateDeg(learn.muMax!, learn.C0!), peakSlipEstimateDeg(1, 0), peakSlipEstimateDeg(3, 1e6));
  }

  return out;
}
