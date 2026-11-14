/**
 * The camera model. Pure: numbers in, numbers out, no BeamNG API. This is what the unit tests drive.
 *
 * Conventions: world frame, Z up. Yaw 0 looks along +Y, positive yaw turns clockwise seen from above
 * (so direction = (sin yaw, cos yaw)).
 */
import { clamp, isNum, sstep, wrapPi } from "../core/mathx";
import { Spring } from "../core/spring";

export interface CamSettings {
  /** distance multiplier */
  dist: number;
  /** height multiplier */
  height: number;
  /** FOV at standstill, deg */
  fov: number;
  /** strength of everything speed/acceleration does (FOV, pull-back, dolly) */
  speed: number;
  /** 0 = follow the car's heading, 1 = follow the direction of travel in a slide */
  drift: number;
  /** yaw lag multiplier */
  loose: number;
  shake: number;
  roll: number;
}

export const defaultSettings: Readonly<CamSettings> = { dist: 1, height: 1, fov: 55, speed: 1, drift: 0.5, loose: 1, shake: 0.5, roll: 1 };

/** Allowed range per setting; anything outside is clamped, anything unusable falls back to the default. */
export const settingRanges: Readonly<Record<keyof CamSettings, readonly [number, number]>> = {
  dist: [0.5, 2.5],
  height: [0.3, 2.5],
  fov: [35, 80],
  speed: [0, 2],
  drift: [0, 1],
  loose: [0.2, 2.5],
  shake: [0, 2],
  roll: [0, 2],
};

export function sanitizeSetting(key: keyof CamSettings, value: unknown): number {
  const r = settingRanges[key];
  return isNum(value) ? clamp(value, r[0], r[1]) : defaultSettings[key];
}

export interface RigInput {
  dt: number;
  /** car centre, world */
  cx: number;
  cy: number;
  cz: number;
  /** unit forward and up vectors of the car, world */
  fx: number;
  fy: number;
  fz: number;
  ux: number;
  uy: number;
  uz: number;
  /** velocity and acceleration, world, m/s and m/s^2 */
  vx: number;
  vy: number;
  vz: number;
  ax: number;
  ay: number;
  az: number;
  /** right stick, -1..1: x = right, y = up */
  stickX: number;
  stickY: number;
  /** zoom input, -1..1: positive = further away */
  zoom: number;
  lookBack: boolean;
  /** centre to rear bumper, m */
  rear: number;
}

export interface RigOutput {
  camX: number;
  camY: number;
  camZ: number;
  /** aim point */
  tx: number;
  ty: number;
  tz: number;
  upX: number;
  upY: number;
  upZ: number;
  fov: number;
  // diagnostics
  dist: number;
  /** how far the camera yaw trails its target, rad */
  lag: number;
  /** slide angle the camera sees, rad */
  slip: number;
  gL: number;
  gLat: number;
  impact: number;
  lookYaw: number;
  lookPitch: number;
}

// --- tuning ---------------------------------------------------------------------------------------------------
/** yaw settle time: slow .. fast (s) */
const YAW_TAU_SLOW = 0.42;
const YAW_TAU_FAST = 0.17;
/** the camera never trails its target by more than this (rad) */
const MAX_LAG = 0.9;
/** FOV added at top speed (deg) */
const FOV_SPEED = 22;
/** the speed effects grow linearly from SPEED_START and are fully in at SPEED_FULL (m/s).
 * (Measured on a real rally stage drive: with the old 4..75 m/s smoothstep the FOV moved only 5 deg below 120 km/h.) */
const SPEED_START = 2;
const SPEED_FULL = 60;
/** orbit: stick rates (rad/s) and limits */
const LOOK_YAW_RATE = 2.8;
const LOOK_PITCH_RATE = 1.4;
const LOOK_PITCH_MIN = -0.3;
const LOOK_PITCH_MAX = 1.0;
const LOOK_DEADZONE = 0.12;
/** seconds without stick input before the view eases back behind the car (only while moving) */
const LOOK_RECENTER_DELAY = 1.5;
const LOOK_RECENTER_TAU = 0.6;
/** acceleration (m/s^2) above which an impact shake starts */
const IMPACT_START = 45;

export class Rig {
  private t = 0;
  private needReset = true;
  private readonly yaw = new Spring();
  private readonly slip = new Spring();
  private readonly zc = new Spring();
  private readonly pitch = new Spring();
  private readonly rollS = new Spring();
  private readonly accL = new Spring();
  private readonly accLat = new Spring();
  private readonly spd = new Spring();
  private readonly amag = new Spring();
  private readonly lookYaw = new Spring();
  private readonly lookPitch = new Spring();
  private readonly lookRateYaw = new Spring();
  private readonly lookRatePitch = new Spring();
  private lookIdle = 0;
  private impact = 0;
  private zoom = 0;
  private lastHYaw = 0;
  private readonly out: RigOutput = {
    camX: 0, camY: 0, camZ: 0, tx: 0, ty: 0, tz: 0, upX: 0, upY: 0, upZ: 1, fov: 55,
    dist: 0, lag: 0, slip: 0, gL: 0, gLat: 0, impact: 0, lookYaw: 0, lookPitch: 0,
  };

  /** Next step() snaps everything to the car (after a teleport, vehicle switch, reset). The orbit view is kept. */
  reset(): void {
    this.needReset = true;
  }

  /** Puts the orbit view back behind the car. */
  recenter(): void {
    this.lookYaw.set(0);
    this.lookPitch.set(0);
  }

  step(s: Readonly<CamSettings>, i: Readonly<RigInput>): RigOutput {
    const dt = i.dt;
    this.t += dt;
    const rear = i.rear;

    // right vector of the car = forward x up
    const rx = i.fy * i.uz - i.fz * i.uy;
    const ry = i.fz * i.ux - i.fx * i.uz;
    const rz = i.fx * i.uy - i.fy * i.ux;

    const speed = math.sqrt(i.vx * i.vx + i.vy * i.vy + i.vz * i.vz);
    const hs = math.sqrt(i.vx * i.vx + i.vy * i.vy);
    const vf = i.vx * i.fx + i.vy * i.fy + i.vz * i.fz;
    let aL = clamp(i.ax * i.fx + i.ay * i.fy + i.az * i.fz, -25, 25);
    let aLat = clamp(i.ax * rx + i.ay * ry + i.az * rz, -25, 25);
    let amagRaw = math.min(math.sqrt(i.ax * i.ax + i.ay * i.ay + i.az * i.az), 400);

    // heading yaw; held while the car points straight up or down
    let hYaw = this.lastHYaw;
    if (i.fx * i.fx + i.fy * i.fy > 0.09) {
      hYaw = math.atan2(i.fx, i.fy);
    }
    this.lastHYaw = hYaw;
    let slipRaw = 0;
    if (hs > 1 && vf > 0) {
      slipRaw = clamp(wrapPi(math.atan2(i.vx, i.vy) - hYaw), -1.2, 1.2) * sstep(hs, 3, 10);
    }
    const sfTarget = clamp((speed - SPEED_START) / (SPEED_FULL - SPEED_START), 0, 1);

    if (this.needReset) {
      this.needReset = false;
      this.yaw.set(hYaw + slipRaw * s.drift);
      this.slip.set(slipRaw);
      this.zc.set(i.cz);
      this.pitch.set(clamp(i.fz, -0.35, 0.35));
      this.rollS.set(0);
      this.accL.set(0);
      this.accLat.set(0);
      this.amag.set(0);
      this.spd.set(sfTarget);
      this.lookRateYaw.set(0);
      this.lookRatePitch.set(0);
      this.impact = 0;
      aL = 0;
      aLat = 0;
      amagRaw = 0;
    }

    // yaw: spring toward heading (+ part of the slide angle); loose when slow, tight when fast
    const slip = this.slip.damp(slipRaw, 0.12, dt);
    const targetYaw = hYaw + slip * s.drift;
    const tau = (YAW_TAU_SLOW + (YAW_TAU_FAST - YAW_TAU_SLOW) * sstep(hs, 2, 28)) * s.loose;
    this.yaw.damp(this.yaw.x + wrapPi(targetYaw - this.yaw.x), tau, dt);
    let lag = wrapPi(targetYaw - this.yaw.x);
    if (math.abs(lag) > MAX_LAG) {
      this.yaw.x = targetYaw - (lag > 0 ? MAX_LAG : -MAX_LAG);
      lag = wrapPi(targetYaw - this.yaw.x);
    }

    // orbit: the stick turns the view at a rate and the view stays where it is left;
    // after a pause, and only while driving, it eases back behind the car
    const stickMag = math.sqrt(i.stickX * i.stickX + i.stickY * i.stickY);
    const stickActive = stickMag > LOOK_DEADZONE;
    const rateYaw = this.lookRateYaw.damp(stickActive ? i.stickX * LOOK_YAW_RATE : 0, 0.07, dt);
    const ratePitch = this.lookRatePitch.damp(stickActive ? -i.stickY * LOOK_PITCH_RATE : 0, 0.07, dt);
    if (stickActive) {
      this.lookIdle = 0;
    } else {
      this.lookIdle += dt;
    }
    if (!stickActive && this.lookIdle > LOOK_RECENTER_DELAY && hs > 3) {
      this.lookYaw.damp(0, LOOK_RECENTER_TAU, dt);
      this.lookPitch.damp(0, LOOK_RECENTER_TAU, dt);
    } else {
      this.lookYaw.set(wrapPi(this.lookYaw.x + rateYaw * dt));
      this.lookPitch.set(clamp(this.lookPitch.x + ratePitch * dt, LOOK_PITCH_MIN, LOOK_PITCH_MAX));
    }
    const lookYaw = this.lookYaw.x + (i.lookBack ? math.pi : 0);
    const lookPitch = this.lookPitch.x;
    this.zoom = clamp(this.zoom + i.zoom * dt * 3, -2, 8);

    // speed and g-forces
    const sf = this.spd.damp(sfTarget, 0.35, dt) * s.speed;
    const gL = this.accL.damp(aL, 0.28, dt) / 9.81;
    const gLat = this.accLat.damp(aLat, 0.25, dt) / 9.81;
    const amag = this.amag.damp(amagRaw, 0.04, dt);
    if (amag > IMPACT_START) {
      this.impact = math.max(this.impact, math.min((amag - IMPACT_START) / 150, 1));
    }
    this.impact = this.impact * math.exp(-dt / 0.22);

    let dist = (rear * 1.55 + 2.6) * s.dist * (1 + 0.1 * sf) + clamp(gL, -1.2, 1.2) * 0.45 * s.speed + this.zoom;
    dist = math.max(dist, rear + 0.3);
    const h = (0.95 + 0.25 * rear) * s.height;
    const fov = clamp(s.fov + FOV_SPEED * sf + clamp(gL, -1, 1) * 2.5 * s.speed + this.impact * 1.5 * s.shake, 20, 110);

    // vertical: the camera rides a spring, the car moves in the frame
    let zc = this.zc.damp(i.cz, 0.09, dt);
    if (math.abs(i.cz - zc) > 1.2) {
      zc = i.cz - (i.cz > zc ? 1.2 : -1.2);
      this.zc.x = zc;
    }
    const sp = this.pitch.damp(clamp(i.fz, -0.35, 0.35), 0.45, dt) * 0.6;

    // place the camera behind (orbit pitch lifts it on an arc), aim at a point ahead that leads into the turn
    const viewYaw = this.yaw.x + lookYaw;
    const dx = math.sin(viewYaw);
    const dy = math.cos(viewYaw);
    const rcx = dy;
    const rcy = -dx;
    const horiz = dist * math.cos(lookPitch);
    let camX = i.cx - dx * horiz;
    let camY = i.cy - dy * horiz;
    let camZ = zc + h + dist * math.sin(lookPitch) - horiz * sp;
    const lead = lag * 0.6 * math.max(0, math.cos(lookYaw));
    const aimYaw = viewYaw + lead;
    const ahead = 0.5 * rear + 1.2 + 1.5 * sf;
    const tx = i.cx + math.sin(aimYaw) * ahead;
    const ty = i.cy + math.cos(aimYaw) * ahead;
    const tz = zc + 0.35 * h + ahead * sp;

    // shake: speed buzz + impacts
    const amp = s.shake * (0.01 * sf * sf + 0.06 * this.impact);
    if (amp > 0) {
      const t = this.t;
      const shx = amp * math.sin(t * 82.3 + 2 * math.sin(t * 7.3));
      const shz = amp * math.sin(t * 60.9 + 1.3 + 2 * math.sin(t * 5.1));
      camX += rcx * shx;
      camY += rcy * shx;
      camZ += shz;
    }

    // roll: a little of the body roll plus a lean from lateral g
    const bodyRoll = clamp(i.ux * rcx + i.uy * rcy, -0.3, 0.3);
    const roll = this.rollS.damp((bodyRoll * 0.25 - clamp(gLat, -1.5, 1.5) * 0.015) * s.roll, 0.2, dt);

    const o = this.out;
    o.camX = camX;
    o.camY = camY;
    o.camZ = camZ;
    o.tx = tx;
    o.ty = ty;
    o.tz = tz;
    o.upX = rcx * roll;
    o.upY = rcy * roll;
    o.upZ = 1;
    o.fov = fov;
    o.dist = dist;
    o.lag = lag;
    o.slip = slip;
    o.gL = gL;
    o.gLat = gLat;
    o.impact = this.impact;
    o.lookYaw = lookYaw;
    o.lookPitch = lookPitch;
    return o;
  }
}
