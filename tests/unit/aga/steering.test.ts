import { describe, expect, it } from "vitest";
import { newSteerModel } from "../../../src/aga/calibration";
import { applyConfig } from "../../../src/aga/config";
import type { Config } from "../../../src/aga/config";
import { Smooth } from "../../../src/aga/smooth";
import { calcCorrectedSteering, calcSteeringRateMult, fillFrameData, newFrameData } from "../../../src/aga/steering";
import type { SteeringContext } from "../../../src/aga/steering";

const DEG = 180 / Math.PI;
const DT = 1 / 60;
const LOCK = 30;
const TARGET = 8; // learned peak slip, deg
const FINAL_TARGET = TARGET * 0.95; // default cfg.targetSlip

function config(over: Partial<Config> = {}): Config {
  const cfg = {} as Config;
  applyConfig(cfg, over, undefined);
  return cfg;
}

interface Motion {
  /** axle velocities in the body frame, m/s (right / forward) */
  fvx?: number;
  fvz?: number;
  rvx?: number;
  rvz?: number;
  grounded?: number;
}

/** Same wiring as the extension: smoothers with the production constants, 30 deg lock, 2.5 m wheelbase. */
function rig(cfgOver: Partial<Config> = {}) {
  const cx: SteeringContext = {
    cfg: config(cfgOver),
    d: newFrameData(),
    steer: { ...newSteerModel(), lockDeg: LOCK },
    selfSteerSmoother: new Smooth(7.0, 0.13, -1, 1, 0),
    counterIndicatorSmoother: new Smooth(12.0, 1.0, 0, 1, 0),
    limitSmoother: new Smooth(11.0, 0.01, 0, 32, 32),
  };
  const setMotion = (m: Motion): void => {
    fillFrameData(cx.d, m.fvx ?? 0, m.fvz ?? 20, m.rvx ?? 0, m.rvz ?? 20, 2.5, 0, 0, 0);
    cx.d.frontGrounded = m.grounded ?? 1;
  };
  /** Holds the inputs for `seconds` and returns the last output. */
  const settle = (m: Motion, stick: number, seconds = 10, fade = 1, brake = 0): number => {
    setMotion(m);
    let out = 0;
    for (let i = 0; i < seconds / DT; i++) out = calcCorrectedSteering(cx, TARGET, stick, Math.abs(stick), fade, brake, DT);
    return out;
  };
  return { cx, setMotion, settle };
}
const lateralFor = (angleDeg: number, fwd = 20) => fwd * Math.tan(angleDeg / DEG);

describe("fillFrameData", () => {
  it("straight ahead", () => {
    const d = newFrameData();
    fillFrameData(d, 0, 20, 0, 20, 2.5, 3, 0.5, 1);
    expect(d).toMatchObject({
      wheelbase: 2.5,
      wheelbaseFactor: 1,
      hVelLen: 20,
      fAxleHVelLen: 20,
      midVelFwd: 20,
      travelDirection: 0,
      yawRateRight: 0,
      fAxleVelAngle: 0,
      rAxleVelAngle: 0,
      rawSteerAngle: 3,
      rearSteerAngle: 0.5,
      steerAngle: 2,
      frontSlipDeg: 2,
    });
  });
  it("yaw rate from the axle velocity difference (positive = nose to the right)", () => {
    const d = newFrameData();
    fillFrameData(d, 1, 20, -1, 20, 2.5, 0, 0, 0);
    expect(d.yawRateRight).toBeCloseTo(0.8, 12);
    expect(d.travelDirection).toBe(0);
    fillFrameData(d, 1, 20, -1, 20, 5, 0, 0, 0);
    expect(d.yawRateRight).toBeCloseTo(0.4, 12);
    expect(d.wheelbaseFactor).toBe(2);
  });
  it("side slip: velocity angles are positive to the right; front slip = wheel angle - travel angle", () => {
    const d = newFrameData();
    fillFrameData(d, 2, 20, 2, 20, 2.5, 10, 0, 0);
    const a = Math.atan2(2, 20) * DEG;
    expect(d.travelDirection).toBeCloseTo(a, 12);
    expect(d.fAxleVelAngle).toBeCloseTo(a, 12);
    expect(d.rAxleVelAngle).toBeCloseTo(a, 12);
    expect(d.frontSlipDeg).toBeCloseTo(10 - a, 12);
    fillFrameData(d, -2, 20, -2, 20, 2.5, 0, 0, 0);
    expect(d.rAxleVelAngle).toBeCloseTo(-a, 12);
  });
  it("reverse: axle angles are 'corrected for reverse' (as AGA), travel direction is not", () => {
    const d = newFrameData();
    fillFrameData(d, 1, -10, 1, -10, 2.5, 0, 0, 0);
    expect(d.midVelFwd).toBe(-10);
    expect(d.fAxleVelAngle).toBeCloseTo(Math.atan2(1, 10) * DEG, 12);
    expect(d.travelDirection).toBeCloseTo(180 - Math.atan2(1, 10) * DEG, 10);
  });
  it("standstill: no direction noise, no NaN", () => {
    const d = newFrameData();
    fillFrameData(d, 0, 0, 0, 0, 2.5, 0, 0, 0);
    expect(d.travelDirection).toBe(0);
    expect(d.fAxleVelAngle).toBe(0);
    expect(d.hVelLen).toBe(0);
    fillFrameData(d, 0.3, 0.3, 0.3, 0.3, 2.5, 0, 0, 0); // below 0.5 m/s
    expect(d.travelDirection).toBe(0);
    expect(d.fAxleVelAngle).toBeCloseTo(45, 12);
  });
  it("does not touch frontGrounded or the diagnostics", () => {
    const d = newFrameData();
    d.frontGrounded = 0.7;
    d.dbgLimit = 0.3;
    fillFrameData(d, 0, 20, 0, 20, 2.5, 0, 0, 0);
    expect(d.frontGrounded).toBe(0.7);
    expect(d.dbgLimit).toBe(0.3);
  });
});

describe("calcSteeringRateMult", () => {
  it("is the plain steering rate when the speed exponent is 0 (filterSetting 0.5)", () => {
    const cfg = config();
    for (const v of [0, 8, 30, 90]) expect(calcSteeringRateMult(cfg, v, LOCK)).toBeCloseTo(0.5, 12);
  });
  it("does not change below 8 m/s", () => {
    const cfg = config({ useFilter: false, rateIncreaseWithSpeed: 0.5 });
    expect(calcSteeringRateMult(cfg, 0, LOCK)).toBeCloseTo(0.5, 12);
    expect(calcSteeringRateMult(cfg, 8, LOCK)).toBeCloseTo(0.5, 12);
  });
  it("a positive exponent speeds the steering up with speed, a negative one slows it down", () => {
    const up = config({ useFilter: false, rateIncreaseWithSpeed: 0.5 });
    const down = config({ useFilter: false, rateIncreaseWithSpeed: -0.5 });
    const ratio = LOCK / (65 / (100 - 7.3) + 3.5);
    expect(calcSteeringRateMult(up, 100, LOCK)).toBeCloseTo(Math.sqrt(ratio) * 0.5, 12);
    expect(calcSteeringRateMult(down, 100, LOCK)).toBeCloseTo(0.5 / Math.sqrt(ratio), 12);
    expect(calcSteeringRateMult(up, 60, LOCK)).toBeGreaterThan(calcSteeringRateMult(up, 30, LOCK));
  });
  it("scales with cfg.steeringRate", () => {
    expect(calcSteeringRateMult(config({ steeringRate: 1 }), 50, LOCK)).toBeCloseTo(1, 12);
  });
});

describe("calcCorrectedSteering", () => {
  // default config: maxDynamicLimitReduction = 5 -> the limit may drop by up to this many degrees
  const MAX_REDUCTION = FINAL_TARGET * 0.4 + (FINAL_TARGET * 0.75 - FINAL_TARGET * 0.4) * 0.5;

  it("straight ahead with a centred stick does nothing", () => {
    const { cx, settle } = rig();
    expect(settle({}, 0)).toBeCloseTo(0, 12);
    expect(cx.d.dbgSelfSteer).toBeCloseTo(0, 12);
    expect(cx.d.dbgCounter).toBe(0);
    expect(cx.d.dbgLimit).toBeCloseTo(FINAL_TARGET / LOCK, 6);
  });

  it("full stick is limited to the target slip angle (in units of steering lock)", () => {
    const { settle } = rig();
    expect(settle({}, 1)).toBeCloseTo(FINAL_TARGET / LOCK, 6);
    expect(rig().settle({}, -1)).toBeCloseTo(-FINAL_TARGET / LOCK, 6);
    expect(rig().settle({}, 0.5)).toBeCloseTo((0.5 * FINAL_TARGET) / LOCK, 6);
  });

  it("the limit follows the front axle's direction of travel while the car turns in", () => {
    const { cx, settle } = rig();
    const fvx = lateralFor(5);
    settle({ fvx, rvx: 0 }, 1);
    expect(cx.d.dbgLimit).toBeCloseTo((FINAL_TARGET + 5) / LOCK, 6);
  });

  it("in understeer the limit is reduced, but by no more than the configured amount", () => {
    const a = rig();
    a.settle({ fvx: lateralFor(-2), rvx: 0 }, 1);
    expect(a.cx.d.dbgLimit).toBeCloseTo((FINAL_TARGET - 2) / LOCK, 6);
    const b = rig();
    b.settle({ fvx: lateralFor(-15), rvx: 0 }, 1);
    expect(b.cx.d.dbgLimit).toBeCloseTo((FINAL_TARGET - MAX_REDUCTION) / LOCK, 6);
    const braking = rig();
    braking.settle({ fvx: lateralFor(-15), rvx: 0 }, 1, 10, 1, 1);
    expect(braking.cx.d.dbgLimit).toBeCloseTo((FINAL_TARGET - MAX_REDUCTION * 0.9) / LOCK, 6);
  });

  it("the limit moves smoothly, starting wide open", () => {
    const { cx, setMotion } = rig();
    setMotion({});
    let prev = Infinity;
    for (let i = 0; i < 120; i++) {
      calcCorrectedSteering(cx, TARGET, 1, 1, 1, 0, DT);
      expect(cx.d.dbgLimit!).toBeLessThanOrEqual(prev);
      prev = cx.d.dbgLimit!;
      if (i === 0) expect(prev).toBeGreaterThan(0.7);
    }
  });

  it("self-steer: hands off, the wheels turn towards where the rear axle is sliding", () => {
    const slide = lateralFor(10);
    const right = rig().settle({ fvx: slide, rvx: slide }, 0);
    const left = rig().settle({ fvx: -slide, rvx: -slide }, 0);
    expect(right).toBeGreaterThan(0.05);
    expect(right).toBeLessThan(10 / LOCK); // progressive: less than full alignment at small angles
    expect(left).toBeCloseTo(-right, 12);
  });

  it("self-steer grows with the slide angle and is capped by maxSelfSteerAngle", () => {
    const at = (deg: number, over: Partial<Config> = {}) => rig(over).settle({ fvx: lateralFor(deg), rvx: lateralFor(deg) }, 0);
    expect(at(20)).toBeGreaterThan(at(10));
    expect(at(40)).toBeGreaterThan(at(20));
    const capped = at(40, { useFilter: false, maxSelfSteerAngle: 6 });
    expect(capped).toBeCloseTo(6 / LOCK, 6);
    expect(at(40, { useFilter: false, maxSelfSteerAngle: 0 })).toBeCloseTo(0, 12);
  });

  it("self-steer response: a higher setting steers more for the same slide", () => {
    const at = (resp: number) =>
      rig({ useFilter: false, selfSteerResponse: resp, dampingStrength: 0 }).settle({ fvx: lateralFor(10), rvx: lateralFor(10) }, 0);
    expect(at(1)).toBeGreaterThan(at(0.37));
    expect(at(0.37)).toBeGreaterThan(at(0));
    // response 1 -> exponent 1 -> aims at full alignment with the rear axle (10 deg = 1/3 of the lock), minus the
    // quadratic easing towards the +-1 cap, whose window spans the whole range when the cap is 90 deg
    const aligned = 10 / LOCK;
    expect(at(1)).toBeCloseTo(1 - ((aligned - 2) / 2) ** 2, 9);
  });

  it("the stick fades self-steer out (anti-self-steer): none left at full stick", () => {
    const slide = lateralFor(10);
    const { cx, settle } = rig();
    const out = settle({ fvx: slide, rvx: slide }, -1);
    expect(cx.d.dbgSelfSteer!).toBeGreaterThan(0.05);
    expect(out).toBeCloseTo(-1 * cx.d.dbgLimit!, 12);
  });

  it("yaw damping steers against the rotation", () => {
    const spin: Motion = { fvx: 1, rvx: -1 }; // rotating to the right
    const damped = rig({ useFilter: false, dampingStrength: 0.5 }).settle(spin, 0);
    const undamped = rig({ useFilter: false, dampingStrength: 0 }).settle(spin, 0);
    expect(damped).toBeLessThan(undamped);
    expect(undamped - damped).toBeCloseTo(0.8 * 0.5 * 0.15 * (30 / LOCK), 9);
  });

  it("reverseDampingFix flips the damping term when travelling backwards, and only then", () => {
    const run = (m: Motion, damping: number, fix: boolean) =>
      rig({ useFilter: false, dampingStrength: damping, reverseDampingFix: fix }).settle(m, 0);
    const backwards: Motion = { fvx: 1, rvx: -1, fvz: -20, rvz: -20 };
    const base = run(backwards, 0, true);
    const original = run(backwards, 0.5, false) - base;
    const fixed = run(backwards, 0.5, true) - base;
    expect(original).toBeLessThan(0);
    expect(fixed).toBeCloseTo(-original, 9);
    const forwards: Motion = { fvx: 1, rvx: -1 };
    expect(run(forwards, 0.5, true)).toBeCloseTo(run(forwards, 0.5, false), 12);
  });

  it("assistFadeIn scales the self-steer (0 = none)", () => {
    const slide = lateralFor(10);
    const full = rig().settle({ fvx: slide, rvx: slide }, 0, 10, 1);
    const half = rig().settle({ fvx: slide, rvx: slide }, 0, 10, 0.5);
    const none = rig().settle({ fvx: slide, rvx: slide }, 0, 10, 0);
    expect(half).toBeCloseTo(full / 2, 12);
    expect(none).toBeCloseTo(0, 12);
  });

  it("(sic) self-steer is not reduced while the front wheels are airborne - same as the original AGA", () => {
    const slide = lateralFor(10);
    const grounded = rig().settle({ fvx: slide, rvx: slide, grounded: 1 }, 0);
    const airborne = rig().settle({ fvx: slide, rvx: slide, grounded: 0 }, 0);
    expect(airborne).toBe(grounded);
  });

  it("countersteering at speed switches to the countersteer limit", () => {
    const rAng = 15;
    const slide = lateralFor(rAng, 30);
    const m: Motion = { fvx: slide, rvx: slide, fvz: 30, rvz: 30 }; // rear sliding right
    const into = rig();
    into.settle(m, 1); // stick right = towards the slide
    expect(into.cx.d.dbgCounter).toBeCloseTo(1, 6);
    const counterMult = (rAng / 30 / 3 + 2 / 3) * 0.8 + 1 * 0.2; // lerp(..., 1, countersteerResponse = 0.2)
    const targetCounter = FINAL_TARGET * (0.2 * counterMult * 0.7 + 0.1) + rAng;
    expect(into.cx.d.dbgLimit).toBeCloseTo(targetCounter / LOCK, 6);

    const away = rig();
    away.settle(m, -1);
    expect(away.cx.d.dbgCounter).toBe(0);
  });

  it("the countersteer indicator fades out at low speed and needs a real slide", () => {
    const slow = rig();
    const s = lateralFor(15, 8);
    slow.settle({ fvx: s, rvx: s, fvz: 8, rvz: 8 }, 1);
    expect(slow.cx.d.dbgCounter).toBe(0); // below 10 m/s (2.5 m wheelbase)
    const small = rig();
    const t = lateralFor(2, 30);
    small.settle({ fvx: t, rvx: t, fvz: 30, rvz: 30 }, 1);
    expect(small.cx.d.dbgCounter).toBe(0); // rear slip below the 4.5 deg threshold window
  });

  it("no limiting when the car is not travelling forwards (sideways / backwards)", () => {
    const sideways = rig();
    sideways.settle({ fvx: 20, rvx: 20, fvz: 0.1, rvz: 0.1 }, 1);
    expect(sideways.cx.d.dbgLimit).toBeCloseTo(1, 6);
    const reversing = rig();
    expect(reversing.settle({ fvz: -10, rvz: -10 }, 1)).toBeCloseTo(1, 9);
    const forwards = rig();
    forwards.settle({ fvx: lateralFor(30), rvx: lateralFor(30) }, -1); // 30 deg of body slip still counts as forwards
    expect(forwards.cx.d.dbgLimit!).toBeLessThan(0.2);
  });

  it("mirror symmetry: mirrored inputs give exactly mirrored outputs", () => {
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const a = rig();
    const b = rig();
    for (let i = 0; i < 3000; i++) {
      if (i % 40 === 0) {
        const m: Motion = { fvx: (rnd() - 0.5) * 30, rvx: (rnd() - 0.5) * 30, fvz: rnd() * 60 - 10, rvz: rnd() * 60 - 10, grounded: rnd() };
        a.setMotion(m);
        b.setMotion({ ...m, fvx: -m.fvx!, rvx: -m.rvx! });
      }
      const stick = Math.round((rnd() * 2 - 1) * 4) / 4;
      const fade = rnd();
      const brake = rnd();
      const oa = calcCorrectedSteering(a.cx, TARGET, stick, Math.abs(stick), fade, brake, DT);
      const ob = calcCorrectedSteering(b.cx, TARGET, -stick, Math.abs(stick), fade, brake, DT);
      expect(ob).toBeCloseTo(-oa, 12);
      expect(Math.abs(oa)).toBeLessThanOrEqual(1);
    }
  });

  it("stays finite and within [-1, 1] for extreme and degenerate inputs", () => {
    const cases: Motion[] = [
      { fvx: 0, fvz: 0, rvx: 0, rvz: 0 },
      { fvx: 500, fvz: -500, rvx: -500, rvz: 500 },
      { fvx: NaN, fvz: NaN, rvx: NaN, rvz: NaN },
      { fvx: 1e-320, fvz: 1e-320, rvx: 0, rvz: 0 },
    ];
    for (const over of [{}, { useFilter: false, maxSelfSteerAngle: 0, selfSteerResponse: 0, maxDynamicLimitReduction: 0 }]) {
      for (const m of cases) {
        const r = rig(over);
        r.setMotion(m);
        for (const stick of [-1, 0, 1]) {
          for (let i = 0; i < 30; i++) {
            const out = calcCorrectedSteering(r.cx, TARGET, stick, Math.abs(stick), 1, 0, DT);
            if (!Number.isNaN(m.fvx)) {
              expect(Number.isFinite(out)).toBe(true);
              expect(Math.abs(out)).toBeLessThanOrEqual(1);
            }
          }
        }
      }
    }
  });

  it("publishes its diagnostics every call", () => {
    const { cx, setMotion } = rig();
    setMotion({ fvx: 1, rvx: 2 });
    expect(cx.d.dbgLimit).toBeUndefined();
    calcCorrectedSteering(cx, TARGET, 0.5, 0.5, 1, 0, DT);
    expect(typeof cx.d.dbgLimit).toBe("number");
    expect(typeof cx.d.dbgSelfSteer).toBe("number");
    expect(typeof cx.d.dbgCounter).toBe("number");
  });
});

describe("rally mode", () => {
  it("below the knee the stick sweeps 0 .. the grip limit, like grip mode at full stick", () => {
    const grip = rig().settle({}, 1);
    const r = rig({ rally: true });
    const atKnee = r.settle({}, 0.65);
    expect(atKnee).toBeCloseTo(grip, 2);
    expect(r.settle({}, 0.325)).toBeCloseTo(grip / 2, 2);
  });
  it("past the knee it steers past the grip limit: full lock when slow, rallyExtraDeg at speed", () => {
    const slow = rig({ rally: true });
    expect(slow.settle({ fvz: 5, rvz: 5 }, 1)).toBeCloseTo(1, 5);
    const fast = rig({ rally: true });
    const out = fast.settle({ fvz: 40, rvz: 40 }, 1);
    const g = fast.cx.d.dbgGrip!;
    expect(out).toBeCloseTo(g + 18 / LOCK, 3);
    expect(fast.cx.d.dbgMax).toBeCloseTo(g + 18 / LOCK, 3);
  });
  it("is monotonic in the stick, with no jump at the knee", () => {
    const r = rig({ rally: true });
    let prev = -1;
    for (let s = 0; s <= 1.0001; s += 0.05) {
      const out = r.settle({ fvz: 25, rvz: 25 }, s, 3);
      expect(out).toBeGreaterThanOrEqual(prev - 1e-9);
      if (prev >= 0) expect(out - prev).toBeLessThan(0.2);
      prev = out;
    }
  });
  it("self-steer still straightens the car when the stick is released", () => {
    const r = rig({ rally: true });
    expect(r.settle({ rvx: lateralFor(15) }, 0)).toBeGreaterThan(0.1);
  });
  it("steering rate multiplier is 1 (no speed filtering)", () => {
    expect(calcSteeringRateMult(config({ rally: true, steeringRate: 0.3 }), 40, LOCK)).toBe(1);
  });
});
