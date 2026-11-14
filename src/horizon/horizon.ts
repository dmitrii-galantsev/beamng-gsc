/**
 * BeamNG glue for the Horizon chase camera: reads the vehicle, feeds the pure model in rig.ts and writes the
 * result back. The file BeamNG loads must return a constructor function; scripts/build.mjs makes the bundle
 * return `create`.
 */
import { clamp, isNum } from "../core/mathx";
import { type CamSettings, defaultSettings, Rig, type RigInput, sanitizeSetting } from "./rig";

const collisionCtor = require("core/cameraModes/collision") as (this: void) => CollisionHelper;

const SETTING_KEYS: readonly (keyof CamSettings)[] = ["dist", "height", "fov", "speed", "drift", "loose", "shake", "roll"];
const RAD2DEG = 57.29577951308232;
/** the GE global table, for the one global the settings app sets */
const globals = _G as unknown as Record<string, unknown>;

class HorizonCam {
  disabledByDefault = false;
  refNodes?: { ref: number; left: number; back: number };
  private rig!: Rig;
  private s!: CamSettings;
  private inp!: RigInput;
  private collision!: CollisionHelper;
  /** 1 = snap to the car, 2+ = also re-measure the vehicle */
  private resetN = 2;
  private rear = 2.3;
  private offR = 0;
  private offF = 0;
  private offU = 0;
  private liveT = 0;

  init(): void {
    this.disabledByDefault = false;
    this.resetN = 2;
    this.rear = 2.3;
    this.offR = 0;
    this.offF = 0;
    this.offU = 0;
    this.liveT = 0;
    this.rig = new Rig();
    this.s = { ...defaultSettings };
    this.inp = {
      dt: 0, cx: 0, cy: 0, cz: 0, fx: 0, fy: 1, fz: 0, ux: 0, uy: 0, uz: 1, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0,
      stickX: 0, stickY: 0, zoom: 0, lookBack: false, rear: 2.3,
    };
    this.collision = collisionCtor();
    this.collision.init();
    this.onSettingsChanged();
  }

  onSettingsChanged(): void {
    for (const k of SETTING_KEYS) {
      this.s[k] = sanitizeSetting(k, tonumber(settings.getValue("hzc_" + k, defaultSettings[k]) as string));
    }
  }

  onVehicleCameraConfigChanged(): void {
    this.resetN += 2;
  }

  onVehicleSwitched(): void {
    this.resetN += 2;
    this.rig.recenter();
  }

  reset(): void {
    this.resetN += 1;
  }

  setRefNodes(centerNodeID: number, leftNodeID: number, backNodeID: number): void {
    this.refNodes = { ref: centerNodeID, left: leftNodeID, back: backNodeID };
  }

  update(data: CameraData): boolean {
    let dt = data.dt;
    if (!isNum(dt) || dt <= 0) {
      dt = 1 / 60;
    }
    if (dt > 0.1) {
      dt = 0.1;
    }
    const nodes = this.refNodes;
    if (nodes === undefined) {
      return false;
    }
    data.res.collisionCompatible = true;
    const veh = data.veh;

    // car frame from the three reference nodes (positions are relative to data.pos)
    const ref = veh.getNodePosition(nodes.ref);
    const left = veh.getNodePosition(nodes.left);
    const back = veh.getNodePosition(nodes.back);
    let fx = ref.x - back.x;
    let fy = ref.y - back.y;
    let fz = ref.z - back.z;
    const fl = math.sqrt(fx * fx + fy * fy + fz * fz);
    if (!(fl > 1e-6)) {
      return false;
    }
    fx /= fl;
    fy /= fl;
    fz /= fl;
    const lx = left.x - ref.x;
    const ly = left.y - ref.y;
    const lz = left.z - ref.z;
    // up = forward x left
    let ux = fy * lz - fz * ly;
    let uy = fz * lx - fx * lz;
    let uz = fx * ly - fy * lx;
    const ul = math.sqrt(ux * ux + uy * uy + uz * uz);
    if (!(ul > 1e-6)) {
      return false;
    }
    ux /= ul;
    uy /= ul;
    uz /= ul;
    // right = forward x up
    const rx = fy * uz - fz * uy;
    const ry = fz * ux - fx * uz;
    const rz = fx * uy - fy * ux;
    const px = data.pos.x + (back.x + left.x) * 0.5;
    const py = data.pos.y + (back.y + left.y) * 0.5;
    const pz = data.pos.z + (back.z + left.z) * 0.5;

    // vehicle size and where its centre sits (measured once per vehicle)
    if (this.resetN > 1) {
      this.rear = 2.3;
      this.offR = 0;
      this.offF = 0;
      this.offU = 0;
      pcall(() => {
        const [bx, by, bz] = be.getObjectOOBBCenterXYZ(veh.getID());
        const rp = veh.getSpawnWorldOOBBRearPoint();
        const rear = math.sqrt((rp.x - bx) * (rp.x - bx) + (rp.y - by) * (rp.y - by) + (rp.z - bz) * (rp.z - bz));
        if (isNum(rear) && rear > 0.8 && rear < 12) {
          this.rear = rear;
        }
        const ox = bx - px;
        const oy = by - py;
        const oz = bz - pz;
        const oR = ox * rx + oy * ry + oz * rz;
        const oF = ox * fx + oy * fy + oz * fz;
        const oU = ox * ux + oy * uy + oz * uz;
        if (isNum(oR) && isNum(oF) && isNum(oU) && math.abs(oR) < 3 && math.abs(oF) < 8 && math.abs(oU) < 4) {
          this.offR = oR;
          this.offF = oF;
          this.offU = oU;
        }
      });
    }
    if (this.resetN > 0) {
      this.rig.reset();
      this.resetN = 0;
    }

    const i = this.inp;
    i.dt = dt;
    i.cx = px + rx * this.offR + fx * this.offF + ux * this.offU;
    i.cy = py + ry * this.offR + fy * this.offF + uy * this.offU;
    i.cz = pz + rz * this.offR + fz * this.offF + uz * this.offU;
    i.fx = fx;
    i.fy = fy;
    i.fz = fz;
    i.ux = ux;
    i.uy = uy;
    i.uz = uz;
    const vel = data.vel;
    const pv = data.prevVel ?? vel;
    i.vx = vel.x;
    i.vy = vel.y;
    i.vz = vel.z;
    i.ax = (vel.x - pv.x) / dt;
    i.ay = (vel.y - pv.y) / dt;
    i.az = (vel.z - pv.z) / dt;
    const mm = MoveManager;
    i.stickX = clamp((mm.yawRight ?? 0) - (mm.yawLeft ?? 0), -1, 1);
    i.stickY = clamp((mm.pitchUp ?? 0) - (mm.pitchDown ?? 0), -1, 1);
    i.zoom = clamp((mm.zoomOut ?? 0) - (mm.zoomIn ?? 0), -1, 1);
    i.lookBack = data.lookBack === true;
    i.rear = this.rear;

    const o = this.rig.step(this.s, i);
    if (!(isNum(o.camX) && isNum(o.camY) && isNum(o.camZ) && isNum(o.tx) && isNum(o.ty) && isNum(o.tz) && isNum(o.fov))) {
      this.resetN += 1;
      return false;
    }
    data.res.fov = o.fov;
    data.res.pos.set(o.camX, o.camY, o.camZ);
    data.res.rot = quatFromDir(vec3(o.tx - o.camX, o.ty - o.camY, o.tz - o.camZ), vec3(o.upX, o.upY, o.upZ));
    this.collision.update(data);

    // live numbers for the settings app (only while it keeps asking)
    const liveLeft = rawget(globals, "hzcLiveT") as number | undefined;
    if (liveLeft !== undefined && liveLeft > 0) {
      rawset(globals, "hzcLiveT", liveLeft - dt);
      this.liveT += dt;
      if (this.liveT > 0.1) {
        this.liveT = 0;
        const speed = math.sqrt(i.vx * i.vx + i.vy * i.vy + i.vz * i.vz);
        guihooks.trigger("hzcLive", {
          kmh: speed * 3.6, fov: o.fov, dist: o.dist, lag: o.lag * RAD2DEG, slip: o.slip * RAD2DEG,
          gL: o.gL, gLat: o.gLat, impact: o.impact, look: o.lookYaw * RAD2DEG,
        });
      }
    }
    return true;
  }
}

/** The constructor BeamNG calls (same contract as the stock camera modes). */
export function create(o?: object): HorizonCam {
  const cam = (o ?? {}) as HorizonCam;
  setmetatable(cam, HorizonCam.prototype as unknown as LuaMetatable<HorizonCam>);
  cam.init();
  return cam;
}
