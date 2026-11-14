import { beforeEach, describe, expect, it } from "vitest";
import { wrapPi } from "../../../src/core/mathx";
import { type CamSettings, defaultSettings, Rig, type RigInput, type RigOutput, sanitizeSetting } from "../../../src/horizon/rig";

const DT = 1 / 60;
const deg = (r: number) => (r * 180) / Math.PI;

/** A scripted car on flat ground: integrates speed/yaw and feeds the rig what the BeamNG glue would. */
class Sim {
  rig = new Rig();
  s: CamSettings = { ...defaultSettings };
  x = 0;
  y = 0;
  z = 0.5;
  yaw = 0;
  v = 0;
  pvx = 0;
  pvy = 0;
  stickX = 0;
  stickY = 0;
  lookBack = false;
  out!: RigOutput;

  run(seconds: number, acc = 0, yawRate = 0, slipDeg = 0, dt = DT, each?: (o: RigOutput) => void): RigOutput {
    const n = Math.round(seconds / dt);
    for (let k = 0; k < n; k++) {
      this.v = Math.max(0, this.v + acc * dt);
      this.yaw += yawRate * dt;
      const tr = this.yaw + (slipDeg * Math.PI) / 180;
      const vx = this.v * Math.sin(tr);
      const vy = this.v * Math.cos(tr);
      this.x += vx * dt;
      this.y += vy * dt;
      const i: RigInput = {
        dt, cx: this.x, cy: this.y, cz: this.z,
        fx: Math.sin(this.yaw), fy: Math.cos(this.yaw), fz: 0, ux: 0, uy: 0, uz: 1,
        vx, vy, vz: 0, ax: (vx - this.pvx) / dt, ay: (vy - this.pvy) / dt, az: 0,
        stickX: this.stickX, stickY: this.stickY, zoom: 0, lookBack: this.lookBack, rear: 2.1,
      };
      this.pvx = vx;
      this.pvy = vy;
      this.out = this.rig.step(this.s, i);
      each?.(this.out);
    }
    return this.out;
  }

  /** view direction relative to the car's heading, deg (0 = looking where the car points) */
  viewVsHeading(): number {
    const o = this.out;
    return deg(wrapPi(Math.atan2(o.tx - o.camX, o.ty - o.camY) - this.yaw));
  }
  /** where the camera sits relative to the car's heading, deg (180 = straight behind) */
  camBearing(): number {
    return deg(wrapPi(Math.atan2(this.out.camX - this.x, this.out.camY - this.y) - this.yaw));
  }
  camDist(): number {
    return Math.hypot(this.x - this.out.camX, this.y - this.out.camY);
  }
}

let sim: Sim;
beforeEach(() => {
  sim = new Sim();
});

describe("framing at rest", () => {
  it("sits behind and above the car, looking forward and slightly down", () => {
    const o = sim.run(1);
    expect(Math.abs(sim.camBearing())).toBeCloseTo(180, 3);
    expect(sim.camDist()).toBeGreaterThan(5);
    expect(sim.camDist()).toBeLessThan(7);
    expect(o.camZ - sim.z).toBeGreaterThan(1);
    expect(o.tz).toBeLessThan(o.camZ);
    expect(o.fov).toBeCloseTo(55, 6);
    expect(sim.viewVsHeading()).toBeCloseTo(0, 6);
  });

  it("distance, height and FOV settings scale the framing", () => {
    const base = sim.run(1);
    const d0 = sim.camDist();
    const h0 = base.camZ - sim.z;
    sim = new Sim();
    sim.s = { ...defaultSettings, dist: 1.5, height: 2, fov: 70 };
    const o = sim.run(1);
    expect(sim.camDist()).toBeCloseTo(d0 * 1.5, 3);
    expect(o.camZ - sim.z).toBeCloseTo(h0 * 2, 3);
    expect(o.fov).toBeCloseTo(70, 6);
  });
});

describe("speed and acceleration", () => {
  it("FOV widens and the camera pulls back with speed; already clearly at 100 km/h", () => {
    const rest = sim.run(1);
    const fov0 = rest.fov;
    const d0 = rest.dist;
    sim.v = 100 / 3.6;
    const at100 = sim.run(4);
    expect(at100.fov - fov0).toBeGreaterThan(7);
    expect(at100.fov - fov0).toBeLessThan(13);
    const fov100 = at100.fov;
    sim.v = 250 / 3.6;
    const at250 = sim.run(4);
    expect(at250.fov).toBeGreaterThan(fov100 + 8);
    expect(at250.fov).toBeLessThanOrEqual(fov0 + 22 + 1e-6);
    expect(at250.dist).toBeGreaterThan(d0 * 1.08);
  });

  it("throttle pushes the camera back, braking pulls it in", () => {
    sim.v = 30;
    const cruise = sim.run(3).dist;
    const accel = sim.run(1.5, 8).dist;
    expect(accel).toBeGreaterThan(cruise + 0.2);
    sim.run(3);
    const before = sim.run(0.1).dist;
    const brake = sim.run(1.5, -10).dist;
    expect(brake).toBeLessThan(before - 0.2);
  });

  it("speed setting 0 switches all of it off", () => {
    sim.s = { ...defaultSettings, speed: 0 };
    const rest = sim.run(1);
    const d0 = rest.dist;
    const f0 = rest.fov;
    const o = sim.run(6, 8);
    expect(o.fov).toBeCloseTo(f0, 6);
    expect(o.dist).toBeCloseTo(d0, 6);
  });
});

describe("turning and sliding", () => {
  it("trails the heading in a turn, more when slow than when fast, and catches up afterwards", () => {
    sim.v = 8;
    sim.run(2);
    sim.run(2, 0, 0.8);
    const slowLag = Math.abs(deg(sim.out.lag));
    sim = new Sim();
    sim.v = 45;
    sim.run(2);
    sim.run(2, 0, 0.8);
    const fastLag = Math.abs(deg(sim.out.lag));
    expect(slowLag).toBeGreaterThan(fastLag * 1.5);
    expect(fastLag).toBeGreaterThan(1);
    sim.run(2);
    expect(Math.abs(deg(sim.out.lag))).toBeLessThan(0.2);
  });

  it("the lag is capped so the car cannot leave the frame", () => {
    sim.v = 5;
    sim.run(1);
    sim.run(3, 0, 6, 0, DT, (o) => expect(Math.abs(o.lag)).toBeLessThanOrEqual(0.9 + 1e-9));
  });

  it("in a slide the view swings toward the direction of travel by the drift setting", () => {
    sim.v = 30;
    sim.run(2);
    sim.run(3, 0, 0, -30); // travelling 30 deg left of where the nose points
    expect(sim.viewVsHeading()).toBeLessThan(-12);
    expect(sim.viewVsHeading()).toBeGreaterThan(-18);
    sim = new Sim();
    sim.s = { ...defaultSettings, drift: 0 };
    sim.v = 30;
    sim.run(2);
    sim.run(3, 0, 0, -30);
    expect(Math.abs(sim.viewVsHeading())).toBeLessThan(0.5);
  });

  it("aims into the turn: the view direction leads the camera's own position", () => {
    sim.v = 20;
    sim.run(2);
    sim.run(1.5, 0, 0.8); // turning right
    const behind = wrapPi(((sim.camBearing() + 180) * Math.PI) / 180); // direction camera -> car, vs heading
    expect(sim.viewVsHeading()).toBeGreaterThan(deg(behind));
  });
});

describe("right stick orbit", () => {
  it("turns at a rate proportional to the stick, without any jump", () => {
    sim.run(1);
    let prev = sim.out.lookYaw;
    let maxStep = 0;
    sim.stickX = 1;
    sim.run(0.5, 0, 0, 0, DT, (o) => {
      maxStep = Math.max(maxStep, Math.abs(wrapPi(o.lookYaw - prev)));
      prev = o.lookYaw;
    });
    expect(deg(maxStep)).toBeLessThan(3); // 2.8 rad/s at 60 fps = 2.7 deg per frame
    const full = deg(sim.out.lookYaw);
    expect(full).toBeGreaterThan(50);
    expect(full).toBeLessThan(85);
    sim = new Sim();
    sim.run(1);
    sim.stickX = 0.5;
    sim.run(0.5);
    expect(deg(sim.out.lookYaw)).toBeGreaterThan(full * 0.4);
    expect(deg(sim.out.lookYaw)).toBeLessThan(full * 0.6);
  });

  it("stays where it is left while parked", () => {
    sim.run(1);
    sim.stickX = -1;
    sim.run(0.6);
    sim.stickX = 0;
    sim.run(0.8); // the turn rate eases out over ~0.2 s after release
    const left = sim.out.lookYaw;
    expect(deg(left)).toBeLessThan(-60);
    sim.run(10);
    expect(sim.out.lookYaw).toBeCloseTo(left, 6);
  });

  it("while driving it holds for 1.5 s, then eases back behind the car", () => {
    sim.v = 20;
    sim.run(1);
    sim.stickX = 1;
    sim.run(0.6);
    sim.stickX = 0;
    sim.run(0.8);
    const held = sim.out.lookYaw;
    sim.run(0.5);
    expect(sim.out.lookYaw).toBeCloseTo(held, 6);
    let prev = held;
    sim.run(4, 0, 0, 0, DT, (o) => {
      expect(Math.abs(o.lookYaw)).toBeLessThanOrEqual(Math.abs(prev) + 1e-9); // monotonic, no snap past centre
      prev = o.lookYaw;
    });
    expect(Math.abs(deg(sim.out.lookYaw))).toBeLessThan(0.5);
  });

  it("stick up looks up (camera drops), stick down raises it, within limits", () => {
    const h0 = sim.run(1).camZ;
    sim.stickY = -1;
    sim.run(3);
    expect(sim.out.camZ).toBeGreaterThan(h0 + 2);
    expect(sim.out.lookPitch).toBeCloseTo(1.0, 6);
    sim.stickY = 1;
    sim.run(3);
    expect(sim.out.camZ).toBeLessThan(h0);
    expect(sim.out.lookPitch).toBeCloseTo(-0.3, 6);
  });

  it("stick drift inside the dead zone does nothing", () => {
    sim.run(1);
    sim.stickX = 0.1;
    sim.run(5);
    expect(sim.out.lookYaw).toBe(0);
  });

  it("look-back is a temporary 180 that does not disturb the orbit position", () => {
    sim.run(1);
    sim.stickX = 1;
    sim.run(0.3);
    sim.stickX = 0;
    sim.run(0.8);
    const held = sim.out.lookYaw;
    sim.lookBack = true;
    sim.run(0.1);
    expect(Math.abs(wrapPi(sim.out.lookYaw - held - Math.PI))).toBeLessThan(1e-6);
    sim.lookBack = false;
    sim.run(0.1);
    expect(sim.out.lookYaw).toBeCloseTo(held, 6);
  });
});

describe("robustness", () => {
  it("bumps move the car in the frame more than they move the camera", () => {
    sim.v = 30;
    sim.run(2);
    let camMin = Infinity;
    let camMax = -Infinity;
    let t = 0;
    const z0 = sim.z;
    sim.run(2, 0, 0, 0, DT, (o) => {
      camMin = Math.min(camMin, o.camZ);
      camMax = Math.max(camMax, o.camZ);
      t += DT;
      sim.z = z0 + 0.15 * Math.sin(t * 25);
    });
    expect(camMax - camMin).toBeLessThan(0.3 * 0.75); // car moves 0.30 m peak to peak
  });

  it("a crash-sized deceleration triggers a shake that fades out", () => {
    sim.v = 40;
    sim.run(2);
    expect(sim.out.impact).toBe(0);
    sim.v = 5; // hit something
    sim.run(0.1);
    expect(sim.out.impact).toBeGreaterThan(0.3);
    sim.run(2);
    expect(sim.out.impact).toBeLessThan(0.01);
  });

  it("normal driving never triggers the impact shake", () => {
    sim.run(4, 9);
    sim.run(3, -11, 0.6, 0, DT, (o) => expect(o.impact).toBe(0)); // 1.1 g braking while turning
  });

  it("same path at 30, 60 and 144 fps ends within a few centimetres and a degree", () => {
    const results = [1 / 30, 1 / 60, 1 / 144].map((dt) => {
      const s = new Sim();
      s.run(3, 6, 0, 0, dt);
      s.run(2, 0, 0.5, 0, dt);
      return { d: s.camDist(), view: s.viewVsHeading(), fov: s.out.fov };
    });
    for (const r of results) {
      expect(Math.abs(r.d - results[1]!.d)).toBeLessThan(0.08);
      expect(Math.abs(r.view - results[1]!.view)).toBeLessThan(1);
      expect(Math.abs(r.fov - results[1]!.fov)).toBeLessThan(0.5);
    }
  });

  it("reset() snaps to the car after a teleport instead of flying there", () => {
    sim.v = 20;
    sim.run(2);
    sim.x += 500;
    sim.yaw += 2;
    sim.pvx = sim.v * Math.sin(sim.yaw);
    sim.pvy = sim.v * Math.cos(sim.yaw);
    sim.rig.reset();
    sim.run(DT);
    expect(Math.abs(sim.camBearing())).toBeGreaterThan(179);
    expect(sim.camDist()).toBeLessThan(8);
  });

  it("output is always finite, even pointing straight up or with zero-length frames", () => {
    const rig = new Rig();
    const base: RigInput = {
      dt: DT, cx: 0, cy: 0, cz: 0, fx: 0, fy: 0, fz: 1, ux: 0, uy: -1, uz: 0, vx: 0, vy: 0, vz: 30, ax: 0, ay: 0, az: -9.81,
      stickX: 0, stickY: 0, zoom: 1, lookBack: false, rear: 2.1,
    };
    for (let k = 0; k < 300; k++) {
      const o = rig.step(defaultSettings, base);
      for (const v of [o.camX, o.camY, o.camZ, o.tx, o.ty, o.tz, o.upX, o.upY, o.fov, o.dist]) {
        expect(Number.isFinite(v)).toBe(true);
      }
    }
  });
});

describe("settings", () => {
  it("clamps to the allowed range and falls back to the default for junk", () => {
    expect(sanitizeSetting("dist", 99)).toBe(2.5);
    expect(sanitizeSetting("fov", 10)).toBe(35);
    expect(sanitizeSetting("drift", 0.3)).toBe(0.3);
    expect(sanitizeSetting("shake", NaN)).toBe(defaultSettings.shake);
    expect(sanitizeSetting("roll", undefined)).toBe(defaultSettings.roll);
  });
});
