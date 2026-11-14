import { describe, expect, it } from "vitest";
import { calibInputs, finishCalibration, newSteerModel, normalizedSteeringToInput } from "../../../src/aga/calibration";

/** Wheel angle of a rack with `lock` deg at full input and the given curve exponent. */
const rack = (lock: number, expo: number) => (u: number) => Math.sign(u) * lock * Math.abs(u) ** expo;
const sweep = (f: (u: number) => number) => calibInputs.map((u) => f(u));

describe("finishCalibration", () => {
  it("a linear rack gives the identity curve, lock and sign +1", () => {
    const steer = newSteerModel();
    expect(finishCalibration(steer, sweep(rack(30, 1)), 0)).toBe("ok");
    expect(steer.lockDeg).toBeCloseTo(30, 12);
    expect(steer.sign).toBe(1);
    expect(steer.calibrated).toBe(true);
    expect(steer.curveIn).toEqual([0, ...calibInputs]);
    steer.curveOut.forEach((y, i) => expect(y).toBeCloseTo(steer.curveIn[i]!, 12));
  });

  it("reproduces the harness car's curve (33 deg lock, exponent 1.15)", () => {
    const steer = newSteerModel();
    expect(finishCalibration(steer, sweep(rack(33, 1.15)), 0)).toBe("ok");
    expect(steer.lockDeg).toBeCloseTo(33, 12);
    expect(steer.curveOut.map((y) => y.toFixed(3))).toEqual(["0.000", "0.071", "0.157", "0.299", "0.451", "0.664", "1.000"]);
  });

  it("detects an inverted steering_input convention and still stores a positive curve", () => {
    const steer = newSteerModel();
    expect(finishCalibration(steer, sweep(rack(-28, 1.1)), 0)).toBe("ok");
    expect(steer.sign).toBe(-1);
    expect(steer.lockDeg).toBeCloseTo(28, 12);
    expect(steer.curveOut.every((y) => y >= 0 && y <= 1)).toBe(true);
    expect(steer.curveOut[steer.curveOut.length - 1]).toBe(1);
  });

  it("keeps the curve strictly increasing (dead zones, noise, overshoot beyond the final lock)", () => {
    const steer = newSteerModel();
    expect(finishCalibration(steer, [0, 0, -0.2, 20, 31, 30], 0)).toBe("ok");
    const o = steer.curveOut;
    expect(o).toHaveLength(7);
    for (let i = 1; i < o.length - 1; i++) expect(o[i]!).toBeGreaterThan(o[i - 1]!);
    expect(o[o.length - 1]).toBe(1);
    expect(Math.max(...o)).toBe(1);
  });

  it("tolerates NaN / missing intermediate samples", () => {
    const steer = newSteerModel();
    expect(finishCalibration(steer, [3, NaN, undefined, 15, 21, 30], 0)).toBe("ok");
    expect(steer.curveOut.every((y) => Number.isFinite(y))).toBe(true);
  });

  it("reports wheels that do not steer, telling rear-steer apart", () => {
    const steer = newSteerModel();
    expect(finishCalibration(steer, sweep(rack(1, 1)), 0)).toBe("nosteer");
    expect(finishCalibration(steer, sweep(rack(1, 1)), undefined)).toBe("nosteer");
    expect(finishCalibration(steer, sweep(rack(1, 1)), 3)).toBe("nosteer");
    expect(finishCalibration(steer, sweep(rack(1, 1)), -12)).toBe("rearsteer");
    expect(finishCalibration(steer, sweep(rack(2.99, 1)), 12)).toBe("rearsteer");
  });

  it("rejects impossible measurements", () => {
    const steer = newSteerModel();
    expect(finishCalibration(steer, sweep(rack(89.5, 1)), 0)).toBe("bad");
    expect(finishCalibration(steer, [1, 2, 3, 4, 5, NaN], 0)).toBe("bad");
    expect(finishCalibration(steer, [1, 2, 3, 4, 5], 0)).toBe("bad"); // sweep incomplete
    expect(finishCalibration(steer, [], 0)).toBe("bad");
  });

  it("leaves the model untouched unless the result is ok", () => {
    const steer = newSteerModel();
    const before = JSON.stringify(steer);
    finishCalibration(steer, sweep(rack(1, 1)), 0);
    finishCalibration(steer, sweep(rack(95, 1)), 0);
    finishCalibration(steer, sweep(rack(1, 1)), 10);
    expect(JSON.stringify(steer)).toBe(before);
    expect(steer.lockDeg).toBe(35);
    expect(steer.sign).toBe(0);
  });

  it("accepts the boundary locks 3 and 89 deg", () => {
    expect(finishCalibration(newSteerModel(), sweep(rack(3, 1)), 0)).toBe("ok");
    expect(finishCalibration(newSteerModel(), sweep(rack(89, 1)), 0)).toBe("ok");
  });
});

describe("normalizedSteeringToInput", () => {
  it("is the identity on the uncalibrated fallback model", () => {
    const steer = newSteerModel();
    for (const a of [-1, -0.3, 0, 0.5, 1]) expect(normalizedSteeringToInput(steer, a)).toBeCloseTo(a, 12);
    expect(normalizedSteeringToInput(steer, 2)).toBe(1);
  });

  it("inverts the measured rack at the calibration points and closely in between", () => {
    const f = rack(33, 1.15);
    const steer = newSteerModel();
    finishCalibration(steer, sweep(f), 0);
    for (const u of calibInputs) {
      expect(normalizedSteeringToInput(steer, f(u) / 33)).toBeCloseTo(u, 9);
      expect(normalizedSteeringToInput(steer, -f(u) / 33)).toBeCloseTo(-u, 9);
    }
    for (let u = 0.02; u < 1; u += 0.02) {
      expect(Math.abs(normalizedSteeringToInput(steer, f(u) / 33) - u)).toBeLessThan(0.012);
    }
  });

  it("is monotonic and bounded", () => {
    const steer = newSteerModel();
    finishCalibration(steer, [0, 0, -0.2, 20, 31, 30], 0);
    let prev = -Infinity;
    for (let a = -1.2; a <= 1.2; a += 0.005) {
      const u = normalizedSteeringToInput(steer, a);
      expect(u).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(Math.abs(u)).toBeLessThanOrEqual(1);
      prev = u;
    }
  });
});
