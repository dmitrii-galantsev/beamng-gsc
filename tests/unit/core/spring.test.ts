import { describe, expect, it } from "vitest";
import { clamp, isNum, sstep, wrapPi } from "../../../src/core/mathx";
import { Spring } from "../../../src/core/spring";

describe("mathx", () => {
  it("clamp and sstep", () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(sstep(0, 1, 2)).toBe(0);
    expect(sstep(3, 1, 2)).toBe(1);
    expect(sstep(1.5, 1, 2)).toBeCloseTo(0.5, 12);
  });

  it("wrapPi maps any angle into [-pi, pi)", () => {
    for (const a of [-20, -Math.PI, -3, -0.1, 0, 0.1, 3, Math.PI, 7, 20]) {
      const w = wrapPi(a);
      expect(w).toBeGreaterThanOrEqual(-Math.PI);
      expect(w).toBeLessThan(Math.PI);
      expect(Math.sin(w)).toBeCloseTo(Math.sin(a), 9);
      expect(Math.cos(w)).toBeCloseTo(Math.cos(a), 9);
    }
  });

  it("isNum rejects NaN, infinities and non-numbers", () => {
    expect(isNum(1.5)).toBe(true);
    expect(isNum(NaN)).toBe(false);
    expect(isNum(Infinity)).toBe(false);
    expect(isNum(undefined)).toBe(false);
    expect(isNum("3")).toBe(false);
  });

  it("Spring settles on the target without overshoot, at any frame rate", () => {
    for (const dt of [1 / 240, 1 / 60, 1 / 20]) {
      const s = new Spring(0);
      let max = 0;
      for (let t = 0; t < 2; t += dt) {
        max = Math.max(max, s.damp(1, 0.3, dt));
      }
      expect(max).toBeLessThanOrEqual(1 + 1e-9);
      expect(s.x).toBeGreaterThan(0.999);
    }
  });

  it("Spring recovers from a NaN target instead of poisoning its state", () => {
    const s = new Spring(2);
    s.damp(NaN, 0.3, 1 / 60);
    expect(isNum(s.x)).toBe(false); // snapped to the (bad) target ...
    s.damp(1, 0.3, 1 / 60);
    expect(s.x).toBe(1); // ... and usable again on the next good one
    expect(s.v).toBe(0);
  });
});
