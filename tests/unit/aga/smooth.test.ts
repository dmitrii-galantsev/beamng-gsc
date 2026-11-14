import { describe, expect, it } from "vitest";
import { Smooth } from "../../../src/aga/smooth";

describe("Smooth (AGALib SmoothTowards)", () => {
  it("starts at `start` (default 0) and reset() returns there", () => {
    const s = new Smooth(4, 1, 0, 1, 1);
    expect(s.state).toBe(1);
    s.get(0, 0.1);
    expect(s.state).not.toBe(1);
    s.reset();
    expect(s.state).toBe(1);
    expect(new Smooth(7, 0.13, -1, 1).state).toBe(0);
  });

  it("linearity 1 gives a constant-rate approach of 0.875 * rate * range per second", () => {
    const s = new Smooth(4, 1, 0, 1, 1);
    expect(s.get(0, 0.1)).toBeCloseTo(1 - 0.35, 12);
    expect(s.get(0, 0.1)).toBeCloseTo(1 - 0.7, 12);
    expect(s.get(0, 0.1)).toBe(0); // lands exactly, no overshoot
    expect(s.get(0, 0.1)).toBe(0);
  });

  it("low linearity approaches exponentially: big errors move faster than small ones", () => {
    const a = new Smooth(7, 0.13, -1, 1, 0);
    const b = new Smooth(7, 0.13, -1, 1, 0);
    const stepBig = a.get(1, 0.01);
    const stepSmall = b.get(0.1, 0.01);
    expect(stepBig).toBeGreaterThan(stepSmall * 3);
    expect(stepBig).toBeLessThan(1);
  });

  it("converges monotonically without overshoot for any dt", () => {
    for (const dt of [0.001, 1 / 60, 0.1, 5]) {
      const s = new Smooth(11, 0.01, 0, 32, 32);
      let prev = s.state;
      for (let i = 0; i < 2000; i++) {
        const y = s.get(6, dt);
        expect(y).toBeLessThanOrEqual(prev);
        expect(y).toBeGreaterThanOrEqual(6);
        prev = y;
      }
      expect(prev).toBeCloseTo(6, 3);
    }
  });

  it("is symmetric in direction", () => {
    const up = new Smooth(7, 0.13, -1, 1, 0);
    const down = new Smooth(7, 0.13, -1, 1, 0);
    for (let i = 0; i < 20; i++) expect(up.get(0.8, 1 / 60)).toBeCloseTo(-down.get(-0.8, 1 / 60), 14);
  });

  it("rateOverride replaces the rate; getMult scales it", () => {
    const a = new Smooth(4, 1, 0, 1, 0);
    const b = new Smooth(4, 1, 0, 1, 0);
    const c = new Smooth(8, 1, 0, 1, 0);
    expect(a.get(1, 0.01, 8)).toBe(c.get(1, 0.01));
    expect(b.getMult(1, 0.01, 2)).toBe(a.state);
    const z = new Smooth(4, 1, 0, 1, 0);
    expect(z.get(1, 0.01, 0)).toBe(0); // an explicit 0 override means "frozen", not "use the default"
  });

  it("holds its state when already on target and for dt = 0", () => {
    const s = new Smooth(7, 0.13, -1, 1, 0.25);
    expect(s.get(0.25, 0.016)).toBe(0.25);
    expect(s.get(1, 0)).toBe(0.25);
  });
});
