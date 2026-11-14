import { describe, expect, it } from "vitest";
import { applyConfig, defaults, ranges } from "../../../src/aga/config";
import type { Config } from "../../../src/aga/config";

function load(data: unknown, override?: boolean): Config {
  const cfg = {} as Config;
  applyConfig(cfg, data, override);
  return cfg;
}

describe("applyConfig", () => {
  it("yields the defaults for a missing / invalid file", () => {
    for (const data of [undefined, null, 42, "x", true]) expect(load(data)).toEqual(defaults);
    expect(load({})).toEqual(defaults);
  });

  it("the factory defaults of the advanced parameters equal what filterSetting 0.5 derives", () => {
    const cfg = load({ filterSetting: 0.5 });
    expect(cfg.rateIncreaseWithSpeed).toBeCloseTo(defaults.rateIncreaseWithSpeed, 12);
    expect(cfg.selfSteerResponse).toBeCloseTo(defaults.selfSteerResponse, 12);
    expect(cfg.dampingStrength).toBeCloseTo(defaults.dampingStrength, 12);
    expect(cfg.maxDynamicLimitReduction).toBeCloseTo(defaults.maxDynamicLimitReduction, 12);
    expect(cfg.countersteerResponse).toBeCloseTo(defaults.countersteerResponse, 12);
    expect(cfg.targetSlip).toBeCloseTo(defaults.targetSlip, 12);
  });

  it("derives the advanced parameters from filterSetting when useFilter is on", () => {
    const cfg = load({ filterSetting: 1, selfSteerResponse: 0.9, targetSlip: 1.4, maxSelfSteerAngle: 10 });
    expect(cfg.rateIncreaseWithSpeed).toBeCloseTo(-0.1, 12);
    expect(cfg.selfSteerResponse).toBeCloseTo(0.62, 12);
    expect(cfg.dampingStrength).toBe(cfg.selfSteerResponse);
    expect(cfg.maxSelfSteerAngle).toBe(90);
    expect(cfg.maxDynamicLimitReduction).toBeCloseTo(6.5, 12);
    expect(cfg.countersteerResponse).toBeCloseTo(0.1, 12);
    expect(cfg.targetSlip).toBeCloseTo(0.93, 12);
    const low = load({ filterSetting: 0 });
    expect(low.rateIncreaseWithSpeed).toBeCloseTo(0.1, 12);
    expect(low.selfSteerResponse).toBeCloseTo(0.12, 12);
    expect(low.maxDynamicLimitReduction).toBeCloseTo(3.5, 12);
    expect(low.countersteerResponse).toBeCloseTo(0.3, 12);
    expect(low.targetSlip).toBeCloseTo(0.97, 12);
  });

  it("keeps the advanced parameters as given when useFilter is off", () => {
    const cfg = load({ useFilter: false, selfSteerResponse: 0.9, targetSlip: 1.4, maxSelfSteerAngle: 10, filterSetting: 1 });
    expect(cfg.selfSteerResponse).toBe(0.9);
    expect(cfg.targetSlip).toBe(1.4);
    expect(cfg.maxSelfSteerAngle).toBe(10);
    expect(cfg.dampingStrength).toBe(defaults.dampingStrength);
  });

  it("clamps every numeric key to its range", () => {
    const big: Record<string, unknown> = { useFilter: false };
    const small: Record<string, unknown> = { useFilter: false };
    for (const k in ranges) {
      big[k] = 1e9;
      small[k] = -1e9;
    }
    const hi = load(big) as unknown as Record<string, number>;
    const lo = load(small) as unknown as Record<string, number>;
    const rs = ranges as Record<string, readonly [number, number]>;
    for (const k in rs) {
      expect(hi[k]).toBe(rs[k]![1]);
      expect(lo[k]).toBe(rs[k]![0]);
    }
    expect(load({ steeringRate: 0 }).steeringRate).toBe(0.01);
    expect(load({ peakSlipDeg: Infinity }).peakSlipDeg).toBe(20);
  });

  it("every numeric setting has a range (nothing numeric is taken unchecked)", () => {
    const defs = defaults as unknown as Record<string, unknown>;
    for (const k in defs) {
      if (typeof defs[k] === "number") expect(ranges).toHaveProperty(k);
    }
  });

  it("ignores unknown keys, wrong types and NaN", () => {
    const cfg = load({
      bogus: 1,
      steeringRate: "fast",
      enabled: 0,
      debug: "yes",
      targetSlip: NaN,
      learnPeakSlip: null,
      calibrate: false,
    });
    expect(cfg).not.toHaveProperty("bogus");
    expect(cfg.steeringRate).toBe(defaults.steeringRate);
    expect(cfg.enabled).toBe(true);
    expect(cfg.debug).toBe(false);
    expect(cfg.targetSlip).toBe(defaults.targetSlip);
    expect(cfg.learnPeakSlip).toBe(true);
    expect(cfg.calibrate).toBe(false);
  });

  it("accepts falsy-but-valid values (false, 0)", () => {
    const cfg = load({ enabled: false, useFilter: false, peakSlipDeg: 0, velocitySmoothing: 0, maxSelfSteerAngle: 0 });
    expect(cfg.enabled).toBe(false);
    expect(cfg.useFilter).toBe(false);
    expect(cfg.maxSelfSteerAngle).toBe(0);
  });

  it("the enable override wins over the file, in both directions", () => {
    expect(load({ enabled: true }, false).enabled).toBe(false);
    expect(load({ enabled: false }, true).enabled).toBe(true);
    expect(load({ enabled: false }, undefined).enabled).toBe(false);
  });

  it("rebuilds the same table in place and forgets values from the previous load", () => {
    const cfg = {} as Config;
    applyConfig(cfg, { steeringRate: 0.9, debug: true }, undefined);
    const same = cfg;
    applyConfig(cfg, {}, undefined);
    expect(cfg).toBe(same);
    expect(cfg.steeringRate).toBe(defaults.steeringRate);
    expect(cfg.debug).toBe(false);
  });

  it("never modifies the defaults", () => {
    const before = JSON.stringify(defaults);
    load({ steeringRate: 0.9, filterSetting: 0.1, enabled: false }, true);
    expect(JSON.stringify(defaults)).toBe(before);
  });
});
