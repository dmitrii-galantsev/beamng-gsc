import { describe, expect, it } from "vitest";
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
} from "../../../src/core/mathx";
import type { LowpassStates } from "../../../src/core/mathx";

describe("clamp / clamp01 / sgn / lerp", () => {
  it("clamps to the range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
    expect(clamp(0, 0, 0)).toBe(0);
    expect(clamp(-Infinity, -2, 2)).toBe(-2);
    expect(clamp(Infinity, -2, 2)).toBe(2);
  });
  it("lets NaN through (callers nanGuard afterwards)", () => {
    expect(clamp(NaN, 0, 1)).toBeNaN();
  });
  it("clamp01", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.25)).toBe(0.25);
    expect(clamp01(7)).toBe(1);
  });
  it("sgn returns -1, 0, 1 and 0 for NaN", () => {
    expect(sgn(3.2)).toBe(1);
    expect(sgn(-1e-300)).toBe(-1);
    expect(sgn(0)).toBe(0);
    expect(sgn(-0)).toBe(0);
    expect(sgn(NaN)).toBe(0);
  });
  it("lerp", () => {
    expect(lerp(2, 6, 0)).toBe(2);
    expect(lerp(2, 6, 1)).toBe(6);
    expect(lerp(2, 6, 0.25)).toBe(3);
    expect(lerp(2, 6, 1.5)).toBe(8); // extrapolates
  });
});

describe("lerpInvSat / inverseLerp", () => {
  it("lerpInvSat saturates", () => {
    expect(lerpInvSat(15, 10, 20)).toBe(0.5);
    expect(lerpInvSat(5, 10, 20)).toBe(0);
    expect(lerpInvSat(25, 10, 20)).toBe(1);
  });
  it("lerpInvSat handles reversed and degenerate ranges", () => {
    expect(lerpInvSat(12, 20, 10)).toBeCloseTo(0.8, 12);
    expect(lerpInvSat(3, 3, 3)).toBe(0);
    expect(lerpInvSat(99, 3, 3)).toBe(0);
  });
  it("inverseLerp is unclamped and 0 for a degenerate range", () => {
    expect(inverseLerp(4.5, 10, 10)).toBe(1);
    expect(inverseLerp(4.5, 10, 4.5)).toBe(0);
    expect(inverseLerp(0, 2, 5)).toBe(2.5);
    expect(inverseLerp(0, 2, -1)).toBe(-0.5);
    expect(inverseLerp(1, 1, 5)).toBe(0);
  });
});

describe("nanGuard", () => {
  it("passes finite numbers", () => {
    expect(nanGuard(1.5)).toBe(1.5);
    expect(nanGuard(0, 9)).toBe(0);
    expect(nanGuard(-3, 9)).toBe(-3);
  });
  it("replaces nil, NaN and infinities by 0 or alt", () => {
    expect(nanGuard(undefined)).toBe(0);
    expect(nanGuard(NaN)).toBe(0);
    expect(nanGuard(Infinity)).toBe(0);
    expect(nanGuard(-Infinity)).toBe(0);
    expect(nanGuard(undefined, 7)).toBe(7);
    expect(nanGuard(NaN, -9.81)).toBe(-9.81);
    expect(nanGuard(Infinity, 33)).toBe(33);
  });
});

describe("signedPow", () => {
  it("is odd and matches pow on the magnitude", () => {
    expect(signedPow(4, 0.5)).toBe(2);
    expect(signedPow(-4, 0.5)).toBe(-2);
    expect(signedPow(0, 1.7)).toBe(0);
    expect(signedPow(-0.5, 2)).toBe(-0.25);
  });
});

describe("clampEased", () => {
  it("passes values well inside the range untouched", () => {
    expect(clampEased(0.3, -1, 1, 0.2)).toBe(0.3);
    expect(clampEased(0, -1, 1, 1)).toBe(0);
  });
  it("hard-limits beyond the easing windows", () => {
    expect(clampEased(5, -1, 1, 0.2)).toBe(1);
    expect(clampEased(-5, -1, 1, 0.2)).toBe(-1);
    expect(clampEased(1.2001, -1, 1, 0.2)).toBe(1);
  });
  it("eases quadratically into the limits", () => {
    // range 2, window 0.2 -> windowScaled 0.4, half 0.2: easing spans [0.8, 1.2] around max
    expect(clampEased(1.0, -1, 1, 0.2)).toBeCloseTo(1 - 0.25 * 0.2, 12); // t = -0.5
    expect(clampEased(-1.0, -1, 1, 0.2)).toBeCloseTo(-1 + 0.25 * 0.2, 12);
  });
  it("is continuous at the window edges and never exceeds the limits", () => {
    const eps = 1e-9;
    for (const edge of [0.8, 1.2, -0.8, -1.2]) {
      expect(clampEased(edge - eps, -1, 1, 0.2)).toBeCloseTo(clampEased(edge + eps, -1, 1, 0.2), 7);
    }
    let prev = -Infinity;
    for (let x = -2; x <= 2; x += 0.001) {
      const y = clampEased(x, -1, 1, 0.5);
      expect(y).toBeGreaterThanOrEqual(-1);
      expect(y).toBeLessThanOrEqual(1);
      expect(y).toBeGreaterThanOrEqual(prev - 1e-12); // monotonic
      prev = y;
    }
  });
  it("is odd for symmetric limits", () => {
    for (const x of [0.1, 0.85, 0.95, 1.05, 1.19, 3]) {
      expect(clampEased(-x, -1, 1, 0.2)).toBeCloseTo(-clampEased(x, -1, 1, 0.2), 12);
    }
  });
  it("degenerates to a plain clamp for a zero window or zero range", () => {
    expect(clampEased(0.5, 0, 1, 0)).toBe(0.5);
    expect(clampEased(1.5, 0, 1, 0)).toBe(1);
    expect(clampEased(-0.5, 0, 1, 0)).toBe(0);
    expect(clampEased(0.3, 0, 0, 1)).toBe(0);
    expect(clampEased(-0.3, 0, 0, 1)).toBe(0);
    expect(clampEased(0, 0, 0, 1)).toBe(0);
  });
  it("works with asymmetric limits (as used for the steering limit)", () => {
    expect(clampEased(-100, -48, 4, 0.03)).toBe(-48);
    expect(clampEased(100, -48, 4, 0.03)).toBe(4);
    expect(clampEased(-10, -48, 4, 0.03)).toBe(-10);
  });
});

describe("inverseLerpClampedEased", () => {
  it("maps the countersteer indicator range 4.5..10 deg to 0..1 with easing", () => {
    expect(inverseLerpClampedEased(4.5, 10, 0, 0, 1, 0.6)).toBe(0);
    expect(inverseLerpClampedEased(4.5, 10, 20, 0, 1, 0.6)).toBe(1);
    expect(inverseLerpClampedEased(4.5, 10, 7.25, 0, 1, 0.6)).toBe(0.5);
    const lo = inverseLerpClampedEased(4.5, 10, 4.5, 0, 1, 0.6); // exactly at the lower limit: half-eased
    expect(lo).toBeCloseTo(0.25 * 0.3, 12);
  });
});

describe("lowpass", () => {
  it("initialises with the first sample", () => {
    const st: LowpassStates = {};
    expect(lowpass(st, "a", 5, 0.016, 0.03)).toBe(5);
    expect(st.a).toBe(5);
  });
  it("moves by dt/tau of the error", () => {
    const st: LowpassStates = { a: 0 };
    expect(lowpass(st, "a", 10, 0.01, 0.1)).toBeCloseTo(1, 12);
    expect(lowpass(st, "a", 10, 0.01, 0.1)).toBeCloseTo(1.9, 12);
  });
  it("snaps when dt >= tau and keeps keys independent (numeric keys too)", () => {
    const st: LowpassStates = {};
    lowpass(st, 1, 0, 0.1, 0.03);
    lowpass(st, 2, 100, 0.1, 0.03);
    expect(lowpass(st, 1, 8, 0.1, 0.03)).toBe(8);
    expect(st[2]).toBe(100);
  });
  it("treats a stored 0 as a valid state (not as 'unset')", () => {
    const st: LowpassStates = { a: 0 };
    expect(lowpass(st, "a", 10, 0.5, 1)).toBe(5);
  });
});

describe("interp", () => {
  const xs = [0, 0.1, 0.2, 0.35, 0.5, 0.7, 1.0];
  const ys = [0, 0.071, 0.157, 0.299, 0.451, 0.664, 1.0];
  it("hits the break points and interpolates linearly between them", () => {
    for (let i = 0; i < xs.length; i++) expect(interp(xs, ys, xs[i]!)).toBeCloseTo(ys[i]!, 12);
    expect(interp(xs, ys, 0.15)).toBeCloseTo((0.071 + 0.157) / 2, 12);
    expect(interp([0, 1], [0, 1], 0.42)).toBeCloseTo(0.42, 12);
  });
  it("is odd-symmetric and saturates", () => {
    expect(interp(xs, ys, -0.5)).toBeCloseTo(-0.451, 12);
    expect(interp(xs, ys, 3)).toBe(1);
    expect(interp(xs, ys, -3)).toBe(-1);
    expect(interp(xs, ys, 0)).toBe(0);
  });
  it("inverts when the tables are swapped", () => {
    for (const u of [0.03, 0.1, 0.27, 0.5, 0.81, 1]) {
      expect(interp(ys, xs, interp(xs, ys, u))).toBeCloseTo(u, 12);
      expect(interp(ys, xs, interp(xs, ys, -u))).toBeCloseTo(-u, 12);
    }
  });
  it("survives repeated x values (zero-width segments)", () => {
    const r = interp([0, 0.5, 0.5, 1], [0, 0.2, 0.6, 1], 0.5);
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeCloseTo(0.2, 12);
  });
  it("maps NaN to 0 (sign of NaN is 0)", () => {
    expect(interp(xs, ys, NaN)).toBe(0);
  });
});
