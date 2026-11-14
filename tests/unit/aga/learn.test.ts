import { describe, expect, it } from "vitest";
import {
  newFrontAxleSample,
  newLearnState,
  peakSlipEstimateDeg,
  sampleFrontAxle,
  updateLearning,
  Why,
} from "../../../src/aga/learn";
import type { FrontAxleSample, LearnFilters, LearnKinematics, LearnState } from "../../../src/aga/learn";
import { Smooth } from "../../../src/aga/smooth";

const RAD = Math.PI / 180;
const G = 9.81;
const TARMAC = 10;
const isTarmac = (m: number | undefined) => m === TARMAC || m === 20;

const kin = (over: Partial<LearnKinematics> = {}): LearnKinematics => ({
  hVelLen: 20,
  fAxleHVelLen: 20,
  fVelFwd: 20,
  rVelFwd: 20,
  yawRateRight: 0,
  frontSlipDeg: 0,
  rAxleVelAngle: 0,
  ...over,
});
const wheel = (over: Partial<WheelData> = {}): WheelData => ({
  downForceRaw: 3500,
  contactMaterialID1: TARMAC,
  contactMaterialID2: TARMAC,
  wheelSpeed: 20,
  ...over,
});
function sample(ws: WheelData[], dd = kin()): FrontAxleSample {
  const out = newFrontAxleSample();
  sampleFrontAxle(out, ws, dd, isTarmac);
  return out;
}

describe("sampleFrontAxle", () => {
  it("sums the load, tracks the lightest wheel and accepts a clean axle", () => {
    expect(sample([wheel({ downForceRaw: 3000 }), wheel({ downForceRaw: 4000 })])).toEqual({
      FzF: 7000,
      minFz: 3000,
      sameMat: true,
      slipRatioOk: true,
      nFront: 2,
    });
  });
  it("treats missing / NaN loads as 0", () => {
    const s = sample([wheel({ downForceRaw: undefined }), wheel({ downForceRaw: NaN })]);
    expect(s.FzF).toBe(0);
    expect(s.minFz).toBe(0);
  });
  it("never accepts an axle with a broken wheel, and does not count its load", () => {
    const s = sample([wheel({ isBroken: true, downForceRaw: 9999 }), wheel()]);
    expect(s).toMatchObject({ FzF: 3500, nFront: 1, sameMat: false });
  });
  it("rejects mixed or non-tarmac surfaces", () => {
    expect(sample([wheel(), wheel({ contactMaterialID1: 20 })]).sameMat).toBe(false); // both tarmac-like but different
    expect(sample([wheel({ contactMaterialID1: 30 }), wheel({ contactMaterialID1: 30 })]).sameMat).toBe(false);
    expect(sample([wheel({ contactMaterialID1: undefined }), wheel({ contactMaterialID1: undefined })]).sameMat).toBe(false);
  });
  it("falls back to the second contact material when the first is 4 (no contact)", () => {
    expect(sample([wheel({ contactMaterialID1: 4 }), wheel()]).sameMat).toBe(true);
    expect(sample([wheel({ contactMaterialID1: 4, contactMaterialID2: 30 }), wheel()]).sameMat).toBe(false);
  });
  it("material id 0 is a real material, not 'unset'", () => {
    const zeroIsTarmac = (m: number | undefined) => m === 0;
    const out = newFrontAxleSample();
    sampleFrontAxle(out, [wheel({ contactMaterialID1: 0 }), wheel({ contactMaterialID1: TARMAC })], kin(), zeroIsTarmac);
    expect(out.sameMat).toBe(false); // second wheel differs from the first (0)
    sampleFrontAxle(out, [wheel({ contactMaterialID1: 0 }), wheel({ contactMaterialID1: 0 })], kin(), zeroIsTarmac);
    expect(out.sameMat).toBe(true);
  });
  it("flags wheel spin / lock-up above 10 % (only above 1 m/s, only for wheels reporting a speed)", () => {
    expect(sample([wheel({ wheelSpeed: 21.9 }), wheel()]).slipRatioOk).toBe(true);
    expect(sample([wheel({ wheelSpeed: 22.1 }), wheel()]).slipRatioOk).toBe(false);
    expect(sample([wheel({ wheelSpeed: 0 }), wheel()]).slipRatioOk).toBe(false);
    expect(sample([wheel({ wheelSpeed: undefined }), wheel()]).slipRatioOk).toBe(true);
    expect(sample([wheel({ wheelSpeed: 5 })], kin({ fAxleHVelLen: 0.9, fVelFwd: 0.9 })).slipRatioOk).toBe(true);
  });
  it("an empty axle yields the neutral sample", () => {
    expect(sample([])).toEqual({ FzF: 0, minFz: Infinity, sameMat: true, slipRatioOk: true, nFront: 0 });
  });
  it("overwrites a reused sample object completely", () => {
    const out = newFrontAxleSample();
    sampleFrontAxle(out, [wheel({ isBroken: true })], kin(), isTarmac);
    sampleFrontAxle(out, [wheel(), wheel()], kin(), isTarmac);
    expect(out).toEqual({ FzF: 7000, minFz: 3500, sameMat: true, slipRatioOk: true, nFront: 2 });
  });
});

describe("peakSlipEstimateDeg", () => {
  it("is 2.4 * muMax / C0 in degrees", () => {
    expect(peakSlipEstimateDeg(1, 2.4 / (8 * RAD))).toBeCloseTo(8, 10);
    expect(peakSlipEstimateDeg(1.2, 2.4 / (8 * RAD))).toBeCloseTo(9.6, 10);
  });
  it("is limited to 4..14 deg and survives C0 = 0", () => {
    expect(peakSlipEstimateDeg(1, 1000)).toBeCloseTo(4, 10);
    expect(peakSlipEstimateDeg(1, 1)).toBeCloseTo(14, 10);
    expect(peakSlipEstimateDeg(1, 0)).toBeCloseTo(14, 10);
  });
});

// ---- estimator scenarios ------------------------------------------------------------------------------------
/** A car on linear tyres: normalized front lateral force = C * alpha. */
class Rig {
  learn: LearnState = newLearnState();
  filt: LearnFilters = { lp: {}, stillT: 0 };
  slip = new Smooth(0.12, 0.05, 0, 15, 7);
  axle = newFrontAxleSample();
  massFront = 700; // kg on the front axle
  readonly dt = 1 / 60;

  constructor(defaultPeak = 8, muPrior = 1) {
    // what resetLearning() does on vehicle load
    this.learn.muPrior = muPrior;
    this.learn.muMax = muPrior;
    this.learn.default = defaultPeak;
    this.learn.C0 = (2.4 * muPrior) / (defaultPeak * RAD);
    this.learn.dirty = false;
    this.slip.state = defaultPeak;
  }

  step(dd: LearnKinematics, ay: number, over: Partial<FrontAxleSample> = {}, ax = 0, dt = this.dt): void {
    const Fz = this.massFront * G;
    Object.assign(this.axle, { FzF: Fz, minFz: Fz / 2, sameMat: true, slipRatioOk: true, nFront: 2 }, over);
    updateLearning(this.learn, this.filt, this.slip, dd, this.axle, 2, G, Math.abs(ay), Math.abs(ax), dt);
  }

  standStill(seconds = 2): void {
    for (let i = 0; i < seconds / this.dt; i++) this.step(kin({ hVelLen: 0, fAxleHVelLen: 0, fVelFwd: 0, rVelFwd: 0 }), 0);
  }

  /** Steady corner at `speed` with front slip `slipDeg` on a tyre of stiffness C (per rad). */
  corner(seconds: number, C: number, slipDeg: number, speed = 20, over: Partial<FrontAxleSample> = {}): void {
    const ay = C * slipDeg * RAD * G; // muF = ay / g
    const dd = kin({ hVelLen: speed, fAxleHVelLen: speed, fVelFwd: speed, rVelFwd: speed, yawRateRight: ay / speed, frontSlipDeg: slipDeg });
    for (let i = 0; i < seconds / this.dt; i++) this.step(dd, ay, over);
  }
}
const stiffnessForPeak = (peakDeg: number) => 2.4 / (peakDeg * RAD);

describe("updateLearning", () => {
  it("does nothing useful until the static front mass is known", () => {
    const rig = new Rig();
    rig.corner(1, stiffnessForPeak(8), 2);
    expect(rig.learn.why).toBe(Why.NoStaticMass);
    expect(rig.learn.mF).toBeUndefined();
    expect(rig.learn.n).toBe(0);
    expect(rig.slip.state).toBe(8);
  });

  it("measures the static front mass after 0.5 s at rest", () => {
    const rig = new Rig();
    for (let i = 0; i < 29; i++) rig.step(kin({ hVelLen: 0 }), 0);
    expect(rig.learn.mF).toBeUndefined();
    rig.standStill(1);
    expect(rig.learn.mF).toBeCloseTo(700, 9);
    expect(rig.learn.mFn).toBeGreaterThan(1);
  });

  it("does not sample the mass while accelerating, with zero load or with a wheel missing", () => {
    const still = kin({ hVelLen: 0 });
    let rig = new Rig();
    for (let i = 0; i < 120; i++) rig.step(still, 0, {}, 0.6);
    expect(rig.learn.mF).toBeUndefined();
    rig = new Rig();
    for (let i = 0; i < 120; i++) rig.step(still, 0.6);
    expect(rig.learn.mF).toBeUndefined();
    rig = new Rig();
    for (let i = 0; i < 120; i++) rig.step(still, 0, { FzF: 0 });
    expect(rig.learn.mF).toBeUndefined();
    rig = new Rig();
    for (let i = 0; i < 120; i++) rig.step(still, 0, { nFront: 1 });
    expect(rig.learn.mF).toBeUndefined();
  });

  it("averages the mass (running mean capped at 600 samples)", () => {
    const rig = new Rig();
    rig.standStill(1);
    rig.massFront = 900;
    rig.standStill(1);
    expect(rig.learn.mF!).toBeGreaterThan(700);
    expect(rig.learn.mF!).toBeLessThan(900);
    rig.standStill(30);
    expect(rig.learn.mFn).toBe(600);
  });

  for (const peak of [5, 8, 11]) {
    it(`learns a ${peak} deg peak from steady sub-limit cornering`, () => {
      const rig = new Rig(8);
      rig.standStill();
      rig.corner(30, stiffnessForPeak(peak), 0.2 * peak); // 48 % of the available grip
      expect(rig.learn.why).toBe(0);
      expect(rig.learn.C0!).toBeCloseTo(stiffnessForPeak(peak), 1);
      expect(rig.learn.n).toBe(600);
      expect(rig.learn.dirty).toBe(true);
      expect(rig.slip.state).toBeCloseTo(peak, 1);
      expect(rig.learn.dbg!.alphaDeg).toBeCloseTo(0.2 * peak, 6);
      expect(rig.learn.dbg!.muF!).toBeCloseTo(0.2 * 2.4, 6);
    });
  }

  it("moves the target by at most 1 deg/s and blends in by confidence", () => {
    const rig = new Rig(8);
    rig.standStill();
    let prev = rig.slip.state;
    const C = stiffnessForPeak(12);
    for (let i = 0; i < 600; i++) {
      rig.corner(rig.dt, C, 3);
      expect(Math.abs(rig.slip.state - prev)).toBeLessThanOrEqual(rig.dt + 1e-12);
      prev = rig.slip.state;
    }
    expect(rig.slip.state).toBeGreaterThan(8);
    expect(rig.slip.state).toBeLessThan(12);
  });

  it("confidence grows by 60 per second of accepted samples regardless of frame rate", () => {
    for (const fps of [30, 60, 144]) {
      const rig = new Rig(8);
      rig.standStill();
      const C = stiffnessForPeak(8);
      const ay = C * 1.5 * RAD * G;
      const dd = kin({ yawRateRight: ay / 20, frontSlipDeg: 1.5 });
      for (let i = 0; i < 2 * fps; i++) rig.step(dd, ay, {}, 0, 1 / fps);
      expect(rig.learn.n).toBeGreaterThan(100);
      expect(rig.learn.n).toBeLessThanOrEqual(120 + 1e-9);
    }
  });

  const gateCases: [string, number, (rig: Rig) => void][] = [
    ["too slow", Why.TooSlow, (r) => r.corner(1, stiffnessForPeak(8), 2, 7)],
    ["wheel spin", Why.WheelSlip, (r) => r.corner(1, stiffnessForPeak(8), 2, 20, { slipRatioOk: false })],
    ["unloaded inner wheel", Why.UnloadedWheel, (r) => r.corner(1, stiffnessForPeak(8), 2, 20, { minFz: 100 })],
    ["wrong / mixed surface", Why.Surface, (r) => r.corner(1, stiffnessForPeak(8), 2, 20, { sameMat: false })],
    ["slip too small to measure", Why.SlipOutOfBand, (r) => r.corner(1, stiffnessForPeak(8), 0.3)],
    ["slip beyond 60 % of the target", Why.SlipOutOfBand, (r) => r.corner(1, 5, 5.5)],
  ];
  for (const [name, bit, drive] of gateCases) {
    it(`gate: ${name} -> no learning, why = ${bit}`, () => {
      const rig = new Rig(8);
      rig.standStill();
      const C0 = rig.learn.C0;
      drive(rig);
      expect(rig.learn.why).toBe(bit);
      expect(rig.learn.C0).toBe(C0);
      expect(rig.learn.n).toBe(0);
      expect(rig.learn.dirty).toBe(false);
    });
  }

  it("gate: reversing, hard acceleration, drifting, counter-rotation, yaw transients, kerbs, sensor mismatch", () => {
    const C = stiffnessForPeak(8);
    const ay = C * 2 * RAD * G;
    const base = { yawRateRight: ay / 20, frontSlipDeg: 2 };
    const run = (dd: LearnKinematics, a = ay, ax = 0): LearnState => {
      const rig = new Rig(8);
      rig.standStill();
      for (let i = 0; i < 60; i++) rig.step(dd, a, {}, ax);
      expect(rig.learn.n).toBe(0);
      return rig.learn;
    };
    expect(run(kin({ ...base, rVelFwd: -1 })).why).toBe(Why.NotForward);
    expect(run(kin(base), ay, 3.5).why).toBe(Why.Accelerating);
    expect(run(kin({ ...base, rAxleVelAngle: -3 })).why).toBe(Why.Drifting);
    expect(run(kin({ ...base, frontSlipDeg: -2 })).why).toBe(Why.NotTurningSame);
    expect(run(kin(base), ay * 3).why).toBe(Why.AccelMismatch); // e.g. sensor in other units, banking
    expect(run(kin(base), 0).why).toBe(Why.AccelMismatch);

    // yaw acceleration: yaw rate ramping at 2 rad/s^2
    const rig = new Rig(8);
    rig.standStill();
    for (let i = 0; i < 30; i++) {
      const r = ay / 20 + (i * 2) / 60;
      rig.step(kin({ yawRateRight: r, frontSlipDeg: 2 }), r * 20);
    }
    expect(rig.learn.why! & Why.YawAccel).toBe(Why.YawAccel);
    expect(rig.learn.n).toBe(0);

    // kerb: front load jumps by 20 % within one frame
    const k = new Rig(8);
    k.standStill();
    k.corner(0.5, C, 1.5);
    const n = k.learn.n;
    expect(n).toBeGreaterThan(0);
    k.massFront = 700 * 1.2;
    k.corner(k.dt, C, 1.5);
    expect(k.learn.why! & Why.Kerb).toBe(Why.Kerb);
    expect(k.learn.n).toBe(n);
    k.corner(k.dt, C, 1.5); // load steady again -> flag clears
    expect(k.learn.why! & Why.Kerb).toBe(0);
  });

  it("near the limit it stops updating the stiffness but raises muMax when more grip is observed", () => {
    const rig = new Rig(8);
    rig.standStill();
    rig.learn.C0 = 30;
    const before = rig.learn.C0;
    // muF = 1.3 > muMax = 1: tyre gives more than the prior
    const ay = 1.3 * G;
    const dd = kin({ yawRateRight: ay / 20, frontSlipDeg: 4 });
    for (let i = 0; i < 120; i++) rig.step(dd, ay);
    expect(rig.learn.why).toBe(Why.NearLimit);
    expect(rig.learn.C0).toBe(before);
    expect(rig.learn.muMax!).toBeGreaterThan(1.25);
    expect(rig.learn.muMax!).toBeLessThanOrEqual(1.3);
  });

  it("muMax relaxes slowly back to the prior and stays within [0.8 * prior, 2.5]", () => {
    const rig = new Rig(8);
    rig.standStill();
    rig.learn.muMax = 2.4;
    rig.corner(60, stiffnessForPeak(8), 2);
    expect(rig.learn.muMax!).toBeLessThan(2.0);
    expect(rig.learn.muMax!).toBeGreaterThan(1.0);
    rig.learn.muMax = 99;
    rig.corner(rig.dt, stiffnessForPeak(8), 2);
    expect(rig.learn.muMax).toBeLessThanOrEqual(2.5);
    rig.learn.muMax = 0.1;
    rig.corner(rig.dt, stiffnessForPeak(8), 2);
    expect(rig.learn.muMax).toBeGreaterThanOrEqual(0.8);
  });

  it("learning in left and right corners is equivalent", () => {
    const run = (dir: number): LearnState => {
      const rig = new Rig(8);
      rig.standStill();
      const C = stiffnessForPeak(6);
      const ay = C * 1.2 * RAD * G;
      const dd = kin({ yawRateRight: (dir * ay) / 20, frontSlipDeg: dir * 1.2 });
      for (let i = 0; i < 600; i++) rig.step(dd, ay);
      return rig.learn;
    };
    expect(run(1).n).toBeGreaterThan(300);
    expect(run(1).C0).toBe(run(-1).C0);
    expect(run(1).n).toBe(run(-1).n);
  });

  it("an untouched estimator keeps the default target", () => {
    const rig = new Rig(9.5);
    rig.standStill(3);
    expect(rig.slip.state).toBe(9.5);
    expect(rig.learn.dirty).toBe(false);
  });
});
