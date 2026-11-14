import { describe, expect, it } from "vitest";
import { applySettings, setSetting } from "../../../src/core/settings";

const defaults = { on: true, gain: 0.5, free: 3 };
const ranges = { gain: [0, 1] as const };

describe("core/settings", () => {
  it("resets to defaults, then takes valid values", () => {
    const cfg = { on: false, gain: 9, free: 0, stray: 1 } as Record<string, unknown>;
    applySettings(cfg, defaults, ranges, { on: false, gain: 0.25, free: "x", unknown: 1 });
    expect(cfg).toMatchObject({ on: false, gain: 0.25, free: 3 });
    expect(cfg["unknown"]).toBeUndefined();
  });
  it("clamps ranged numbers, ignores NaN and wrong types, accepts numeric strings", () => {
    const cfg = {};
    applySettings(cfg, defaults, ranges, { gain: 7, free: NaN, on: 1 });
    expect(cfg).toEqual({ on: true, gain: 1, free: 3 });
    applySettings(cfg, defaults, ranges, { gain: "0.75", free: "12" });
    expect(cfg).toEqual({ on: true, gain: 0.75, free: 12 });
    applySettings(cfg, defaults, ranges, { gain: "abc" });
    expect(cfg).toEqual(defaults);
  });
  it("tolerates missing or non-object data", () => {
    for (const d of [undefined, null, 5, "x"]) {
      const cfg = {};
      applySettings(cfg, defaults, ranges, d);
      expect(cfg).toEqual(defaults);
    }
  });
  it("setSetting: type-checked and clamped live change", () => {
    const cfg = { ...defaults };
    expect(setSetting(cfg, defaults, ranges, "gain", 2)).toBe(true);
    expect(cfg.gain).toBe(1);
    expect(setSetting(cfg, defaults, ranges, "gain", "0.3")).toBe(false);
    expect(setSetting(cfg, defaults, ranges, "on", false)).toBe(true);
    expect(cfg.on).toBe(false);
    expect(setSetting(cfg, defaults, ranges, "nope", 1)).toBe(false);
    expect(setSetting(cfg, defaults, ranges, 5, 1)).toBe(false);
  });
});
