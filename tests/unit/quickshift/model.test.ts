import { describe, expect, it } from "vitest";
import { adjustedAvgAV, applyConfig, decide, defaultConfig, newDecision, newState, setNumeric } from "../../../src/quickshift/model";
import type { Config, Inputs } from "../../../src/quickshift/model";

function cfg(over: Partial<Config> = {}): Config {
  const c = {} as Config;
  applyConfig(c, undefined);
  return Object.assign(c, over);
}
const coasting: Inputs = { throttle: 0, brake: 0, speed: 20, gearIndex: 5, arcade: true, autoGear: true, avgAV: 80 };
const frame = (c: Config, s: ReturnType<typeof newState>, i: Inputs, n = 1) => {
  let d = decide(c, s, i, 1 / 60);
  for (let k = 1; k < n; k++) d = decide(c, s, i, 1 / 60);
  return d;
};

describe("config", () => {
  it("falls back to the defaults for nil, junk and wrong types", () => {
    for (const data of [undefined, 5, "x", { coastAggression: "high", enabled: 1 }]) {
      const c = cfg({ coastAggression: 0.1 });
      applyConfig(c, data);
      expect(c).toEqual(defaultConfig);
    }
  });
  it("clamps numbers into their range and takes booleans", () => {
    const c = cfg();
    applyConfig(c, { coastAggression: 7, neutralDelay: -1, reverseAssist: false, holdTime: 0.2 });
    expect(c.coastAggression).toBe(1);
    expect(c.neutralDelay).toBe(0.02);
    expect(c.reverseAssist).toBe(false);
    expect(c.holdTime).toBe(0.2);
  });
  it("setNumeric rejects unknown names and non-numbers", () => {
    const c = cfg();
    expect(setNumeric(c, "coastDelay", 0.2)).toBe(true);
    expect(c.coastDelay).toBe(0.2);
    expect(setNumeric(c, "nope", 1)).toBe(false);
    expect(setNumeric(c, "coastDelay", "x")).toBe(false);
    expect(setNumeric(c, "coastDelay", NaN)).toBe(false);
  });
});

describe("coast assist", () => {
  it("holds aggression, caps the delay and opens the throttle gate while coasting", () => {
    const d = frame(cfg(), newState(), coasting);
    expect(d.coasting).toBe(true);
    expect(d.floor).toBe(0.75);
    expect(d.delayCap).toBe(0.1);
    expect(d.gate).toBe(0.5);
  });
  it.each([
    ["throttle applied", { throttle: 0.3 }],
    ["too slow", { speed: 1 }],
    ["first gear", { gearIndex: 1 }],
    ["neutral", { gearIndex: 0 }],
    ["reverse", { gearIndex: -1, speed: -5 }],
    ["not auto-shifting", { autoGear: false }],
  ])("does nothing when %s", (_name, over) => {
    const d = frame(cfg(), newState(), { ...coasting, ...over });
    expect(d.coasting).toBe(false);
    expect(d.floor).toBe(0);
    expect(d.delayCap).toBe(-1);
    expect(d.gate).toBe(-1);
  });
  it("can be switched off", () => {
    expect(frame(cfg({ coastAssist: false }), newState(), coasting).coasting).toBe(false);
  });
  it("keeps the aggression floor for a grace period after the throttle returns, but not the delay cap", () => {
    const c = cfg();
    const s = newState();
    frame(c, s, coasting);
    const d = frame(c, s, { ...coasting, throttle: 0.3 });
    expect(d.coasting).toBe(false);
    expect(d.floor).toBe(0.75);
    expect(d.delayCap).toBe(-1);
    expect(d.gate).toBe(-1);
    const later = frame(c, s, { ...coasting, throttle: 0.3 }, 40); // ~0.67 s > 0.5 s grace
    expect(later.floor).toBe(0);
  });
  it("holds the floor for downshiftHold after an assisted downshift, even once the throttle is back", () => {
    const c = cfg();
    const s = newState();
    frame(c, s, coasting);
    frame(c, s, { ...coasting, gearIndex: 4 }); // the downshift
    const back = { ...coasting, gearIndex: 4, throttle: 0.5 };
    expect(frame(c, s, back, 40).floor).toBe(0.75); // ~0.67 s: past the grace, inside the hold
    expect(frame(c, s, back, 60).floor).toBe(0); // ~1.67 s total: hold over
  });
  it("keeps the hold through a hard throttle press, but a plain upshift starts none", () => {
    const c = cfg();
    const s = newState();
    frame(c, s, coasting);
    frame(c, s, { ...coasting, gearIndex: 4 });
    expect(frame(c, s, { ...coasting, gearIndex: 4, throttle: 0.9 }, 3).floor).toBe(0.75);
    const s2 = newState();
    frame(c, s2, { ...coasting, throttle: 0.5, gearIndex: 4 });
    frame(c, s2, { ...coasting, throttle: 0.5, gearIndex: 5 });
    expect(frame(c, s2, { ...coasting, throttle: 0.5, gearIndex: 5 }).floor).toBe(0);
  });
  it("forbids upshifts only inside the hold and while the throttle is not hard down", () => {
    const c = cfg();
    const s = newState();
    expect(frame(c, s, coasting).blockUp).toBe(false);
    expect(frame(c, s, { ...coasting, gearIndex: 4 }).blockUp).toBe(true);
    expect(frame(c, s, { ...coasting, gearIndex: 4, throttle: 0.4 }).blockUp).toBe(true);
    expect(frame(c, s, { ...coasting, gearIndex: 4, throttle: 0.9 }).blockUp).toBe(false);
    expect(frame(c, s, { ...coasting, gearIndex: 4, throttle: 0.4 }, 120).blockUp).toBe(false); // hold over
  });
  it("drops the grace floor on a hard throttle press", () => {
    const c = cfg();
    const s = newState();
    frame(c, s, coasting);
    expect(frame(c, s, { ...coasting, throttle: 0.9 }).floor).toBe(0);
  });
  it("applies in the D/S modes of a realistic-behaviour automatic (autoGear without arcade)", () => {
    expect(frame(cfg(), newState(), { ...coasting, arcade: false }).coasting).toBe(true);
  });
});

describe("reverse assist", () => {
  const stopped: Inputs = { throttle: 0, brake: 0.8, speed: 0.2, gearIndex: 1, arcade: true, autoGear: true, avgAV: 0.6 };
  it("helps D/N -> R once the brake has been held and the car is nearly still", () => {
    const c = cfg();
    const s = newState();
    expect(frame(c, s, { ...stopped, brake: 0 }).avgMode).toBe(0);
    expect(decide(c, s, stopped, 0.01).avgMode).toBe(0); // held only 10 ms (< holdTime)
    expect(frame(c, s, stopped, 5).avgMode).toBe(1);
    expect(frame(c, s, { ...stopped, gearIndex: 0 }).avgMode).toBe(1);
  });
  it.each([
    ["still moving", { speed: 2 }],
    ["rolling backwards fast", { speed: -2 }],
    ["throttle pressed", { throttle: 0.1 }],
    ["already reversing", { gearIndex: -1, speed: -0.3, avgAV: -3 }],
    ["third gear", { gearIndex: 3 }],
    ["not arcade", { arcade: false }],
  ])("does not help D -> R when %s", (_n, over) => {
    expect(frame(cfg(), newState(), { ...stopped, ...over }, 10).avgMode).toBe(0);
  });
  it("keeps helping in R while still creeping forward, so R does not drop back to N", () => {
    expect(frame(cfg(), newState(), { ...stopped, gearIndex: -1, avgAV: 3 }, 5).avgMode).toBe(1);
  });
  const reversing: Inputs = { throttle: 0.9, brake: 0, speed: -2, gearIndex: -1, arcade: true, autoGear: true, avgAV: -6 };
  it("helps R -> D while still rolling backwards slowly", () => {
    expect(frame(cfg(), newState(), reversing, 5).avgMode).toBe(2);
  });
  it("keeps helping R -> D in N (the stock logic goes R -> N -> D)", () => {
    expect(frame(cfg(), newState(), { ...reversing, gearIndex: 0 }, 5).avgMode).toBe(2);
    expect(frame(cfg(), newState(), { ...reversing, gearIndex: 1 }, 5).avgMode).toBe(0);
  });
  it.each([
    ["rolling back too fast", { speed: -8 }],
    ["brake pedal also down", { brake: 0.4 }],
    ["stock condition already met", { avgAV: -0.4 }],
    ["only a light touch", { throttle: 0.2 }],
  ])("does not help R -> D when %s", (_n, over) => {
    expect(frame(cfg(), newState(), { ...reversing, ...over }, 10).avgMode).toBe(0);
  });
  it("can be switched off", () => {
    expect(frame(cfg({ reverseAssist: false }), newState(), reversing, 10).avgMode).toBe(0);
  });
  it("writes into the decision it is given and returns it", () => {
    const out = newDecision();
    const c = cfg();
    const s = newState();
    for (let k = 0; k < 5; k++) expect(decide(c, s, reversing, 1 / 60, out)).toBe(out);
    expect(out.avgMode).toBe(2);
    decide(c, s, coasting, 1 / 60, out);
    expect(out).toEqual({ coasting: true, floor: 0.75, delayCap: 0.1, gate: 0.5, avgMode: 0, blockUp: false });
  });
  it("adjusts the wheel speed in the right direction only", () => {
    expect(adjustedAvgAV(1, 0.6)).toBe(0.1);
    expect(adjustedAvgAV(1, -3)).toBe(-3);
    expect(adjustedAvgAV(2, -6)).toBe(-0.5);
    expect(adjustedAvgAV(2, 2)).toBe(2);
    expect(adjustedAvgAV(0, -6)).toBe(-6);
  });
});
