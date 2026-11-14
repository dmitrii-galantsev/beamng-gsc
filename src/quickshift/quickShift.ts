// QuickShift - extension entry point (everything that touches the BeamNG API lives here).
// See src/header.lua for the user-facing description; it is prepended to the build output.
//
// The decisions are made by the pure model (model.ts, unit-tested under Node). This file finds the stock shift logic
// module, adjusts the values it reads and publishes a little telemetry; it is only exercised by the LuaJIT
// integration harness, so it may use Lua-only constructs (pcall, pairs, ...).
import { clamp, nanGuard } from "../core/mathx";
import { humanDriving, readSettingsFile } from "../core/vehicle";
import { adjustedAvgAV, applyConfig, decide, newDecision, newState, resetState, setOption } from "./model";
import type { AvgMode, Config, Inputs } from "./model";

const max = math.max;
const min = math.min;

const CONFIG_PATH = "settings/quickShift.json";
const LOGIC_PREFIX = "controller/vehicleController/shiftLogic/";
const TAG = "quickShift";

const cfg = {} as Config;
let enabledOverride: boolean | undefined = undefined;
const state = newState();

// ===== attachment to the stock shift logic =========================================================
/**
 * Identity of this copy of the extension. The game can end up with two copies in one VM (hand-loaded plus auto-loaded,
 * or a tool that re-runs the extension loader). Two copies that both wrap the shift logic's update function wrap each
 * other and recurse until the Lua stack overflows, so only the copy that put its mark on the shift logic may hook it.
 */
const me = {};
let blocked = false;
let blockedTimer = 0;
let logic: ShiftLogicModule | undefined = undefined;
let smoothed: ShiftSmoothedValues | undefined = undefined;
let timer: ShiftTimer | undefined = undefined;
let constants: ShiftTimerConstants | undefined = undefined;
let gearbox: GearboxDevice | undefined = undefined;
/** obj has the allocation-free getVelocityXYZ / getDirectionVectorXYZ */
let hasXYZ = false;
let origNeutral: number | undefined = undefined;
let origGate = 0.05;
let findTimer = 0;
let findTries = 0;
let origUpdate: ((this: void, dt: number) => void) | undefined = undefined;
/** avg wheel speed adjustment for the next call of the shift logic (set by updateGFX, applied by the hook) */
let pendingMode: AvgMode = 0;
/** forbid the logic's upshifts for the next call (set by updateGFX, applied by the hook) */
let pendingBlockUp = false;
/** seconds since the hook last ran; the active shift logic runs it every frame, a stale module never does */
let hookAge = 0;
/** a module found to be inactive (the shifter mode was switched, the controller loaded another logic) and when to forget that */
let deadLogic: ShiftLogicModule | undefined = undefined;
let deadTimer = 0;
let deadLogged = false;
let logicName = "";
/** gear read: a new value counts once it has been read twice in a row (the logic's index can blip for one frame) */
let stableGear = 0;
let candidateGear = 0;
let gearSeeded = false;

function loadConfig(): void {
  applyConfig(cfg, readSettingsFile(CONFIG_PATH));
  if (enabledOverride !== undefined) cfg.enabled = enabledOverride;
}

function findLogic(): ShiftLogicModule | undefined {
  let best: ShiftLogicModule | undefined = undefined;
  let bestScore = -1;
  let bestName = "";
  const n = string.len(LOGIC_PREFIX);
  // `package` is a reserved word in TypeScript modules: reach the Lua global through _G
  const loaded = (_G as unknown as { package: { loaded: LuaTable<string, unknown> } }).package.loaded;
  for (const [name, mod] of pairs(loaded)) {
    if (typeof name === "string" && string.sub(name, 1, n) === LOGIC_PREFIX && type(mod) === "table") {
      const m = mod as ShiftLogicModule;
      if (type(m.updateGearboxGFX) === "function" && type(m.smoothedValues) === "table" && type(m.timer) === "table" && type(m.timerConstants) === "table") {
        // a switched shifter mode leaves the old module loaded: skip one known to be inactive, prefer one the controller has been feeding
        let score = m === deadLogic ? 0 : 2;
        if (type(m.shiftBehavior) === "table") score = score + 1;
        if (score > bestScore) {
          best = m;
          bestScore = score;
          bestName = string.sub(name, n + 1);
        }
      }
    }
  }
  if (best !== undefined) logicName = bestName;
  return best;
}

/** Hands back everything we changed (the hook, the delay constant, the throttle gate). */
function detach(): void {
  if (logic !== undefined && logic.updateGearboxGFX === hookedUpdate && origUpdate !== undefined) logic.updateGearboxGFX = origUpdate;
  if (logic !== undefined && logic.qsOwner === me) logic.qsOwner = undefined;
  if (constants !== undefined && origNeutral !== undefined) constants.neutralSelectionDelay = origNeutral;
  if (smoothed !== undefined) smoothed.throttleUpShiftThreshold = origGate;
  logic = undefined;
  smoothed = undefined;
  timer = undefined;
  constants = undefined;
  origNeutral = undefined;
  origUpdate = undefined;
  pendingMode = 0;
  pendingBlockUp = false;
  gearSeeded = false;
  decided = false;
}

/** false when another copy of the extension already owns this shift logic (this copy then stays idle and retries) */
function attach(found: ShiftLogicModule): boolean {
  if (found.qsOwner !== undefined && found.qsOwner !== me) {
    if (!blocked) log("W", TAG, "another copy of QuickShift is already active on this vehicle: this one stays idle");
    blocked = true;
    blockedTimer = 0;
    return false;
  }
  blocked = false;
  found.qsOwner = me;
  logic = found;
  smoothed = found.smoothedValues;
  timer = found.timer;
  constants = found.timerConstants;
  origNeutral = constants!.neutralSelectionDelay;
  origGate = nanGuard(smoothed!.throttleUpShiftThreshold, 0.05);
  gearbox = powertrain.getDevice("gearbox");
  const [ok, xyz] = pcall(() => obj.getVelocityXYZ !== undefined && obj.getDirectionVectorXYZ !== undefined);
  hasXYZ = ok && xyz === true;
  findTries = 0;
  hookAge = 0;
  log("I", TAG, "attached to the stock shift logic [" + logicName + "] (neutral delay " + tostring(origNeutral) + " s -> " + tostring(cfg.neutralDelay) + " s)");
  return true;
}

/**
 * Wrapper around the shift logic's per-frame function. The controller recomputes the smoothed wheel speed right
 * before calling it, so the "stopped" help has to be applied here. Everything else is written in updateGFX.
 * The real value is put back afterwards: the rest of the frame (electrics.smoothShiftLogicAV, the AI, our own next
 * decision) must see the true wheel speed, otherwise the help would switch itself off every other frame.
 */
let inHook = false;
function hookedUpdate(dt: number): void {
  // never recurse: a wrapper cycle must cost one skipped frame, not a stack overflow
  if (inHook) return;
  inHook = true;
  hookAge = 0;
  const sm = smoothed;
  const sp = logic !== undefined ? logic.shiftPreventionData : undefined;
  const prevUp = sp !== undefined ? sp.wheelSlipShiftUp : undefined;
  let blockedUp = false;
  if (pendingBlockUp && sp !== undefined && prevUp !== false) {
    sp.wheelSlipShiftUp = false;
    blockedUp = true;
  }
  const raw = sm !== undefined ? sm.avgAV : undefined;
  let adjusted: number | undefined = undefined;
  if (pendingMode !== 0 && sm !== undefined && raw !== undefined && type(raw) === "number") {
    adjusted = adjustedAvgAV(pendingMode, raw);
    sm.avgAV = adjusted;
  }
  const [ok, err] = pcall(origUpdate!, dt);
  inHook = false;
  if (adjusted !== undefined && sm !== undefined && sm.avgAV === adjusted) sm.avgAV = raw;
  if (blockedUp && sp !== undefined && sp.wheelSlipShiftUp === false) sp.wheelSlipShiftUp = prevUp;
  if (!ok) error(err, 0);
}

/** The shift logic swaps its own update function when it starts / ends a gear change: wrap whatever is there now. */
function ensureHook(): void {
  const cur = logic!.updateGearboxGFX;
  if (cur !== hookedUpdate && type(cur) === "function") {
    origUpdate = cur;
    logic!.updateGearboxGFX = hookedUpdate;
  }
}

// ===== telemetry =============================================================================
let clock = 0;
let coastSince = -1;
let lastGear = 0;
let lastMode: AvgMode = 0;
/** reused every frame (no per-frame allocation) */
const decision = newDecision();
let decided = false;
const inputs: Inputs = { throttle: 0, brake: 0, speed: 0, gearIndex: 0, arcade: false, autoGear: false, avgAV: 0 };

function publish(d: typeof decision | undefined): void {
  const ev = electrics.values;
  ev.qsEnabled = cfg.enabled ? 1 : 0;
  ev.qsAttached = logic !== undefined ? 1 : 0;
  ev.qsCoast = d !== undefined && d.coasting ? 1 : 0;
  ev.qsReverse = d !== undefined ? d.avgMode : 0;
}

function logEvents(d: typeof decision, gearIndex: number, speed: number): void {
  if (d.coasting && coastSince < 0) {
    coastSince = clock;
  }
  if (gearIndex < lastGear && gearIndex > 0 && lastGear > 0 && (d.coasting || state.grace > 0)) {
    const since = coastSince >= 0 ? clock - coastSince : 0;
    log("I", TAG, string.format("coast downshift %d -> %d  %.2fs after lift  %.0f km/h", lastGear, gearIndex, since, speed * 3.6));
  }
  if (gearIndex > lastGear && lastGear > 0 && (state.hold > 0 || state.grace > 0 || coastSince >= 0)) {
    // upshift shortly after a coast: shows why the logic took it (rpm, aggression it saw, our hold)
    const agg = smoothed !== undefined ? nanGuard(smoothed.drivingAggression) : 0;
    const gb = gearbox !== undefined ? nanGuard(gearbox.gearIndex, -99) : -99;
    const cur = logic !== undefined ? nanGuard(logic.currentGearIndex, -99) : -99;
    const shifting = logic !== undefined && logic.isShifting === true ? "yes" : "no";
    const delay = timer !== undefined ? nanGuard(timer.gearChangeDelayTimer) : 0;
    const rpm = nanGuard(electrics.values.rpm);
    const thr = nanGuard(electrics.values.throttle_input);
    log("I", TAG, string.format("upshift %d -> %d  %.0f rpm  aggression %.2f  hold left %.2fs  throttle %.2f", lastGear, gearIndex, rpm, agg, state.hold, thr));
    log("I", TAG, string.format("  upshift detail: cur=%d gearbox=%d shifting=%s delay=%.2f", cur, gb, shifting, delay));
  }
  if (!d.coasting && state.grace <= 0) coastSince = -1;
  if (d.avgMode !== lastMode && d.avgMode !== 0) {
    log("I", TAG, string.format("%s  %.1f km/h", d.avgMode === 1 ? "reverse help (D/N -> R)" : "drive help (R -> D)", speed * 3.6));
  }
  lastMode = d.avgMode;
  lastGear = gearIndex;
}

// ===== per frame ================================================================================
/** m/s along the car's forward direction (getDirectionVector points forward, as in the stock ai.lua) */
function readSpeed(): number {
  if (hasXYZ) {
    const [vx, vy, vz] = obj.getVelocityXYZ!();
    const [fx, fy, fz] = obj.getDirectionVectorXYZ!();
    return nanGuard(vx * fx + vy * fy + vz * fz);
  }
  const v = obj.getVelocity();
  const f = obj.getDirectionVector();
  return nanGuard(v.x * f.x + v.y * f.y + v.z * f.z);
}

/** The logic's current gear: currentGearIndex (all stock logics; the dct and electric motor have no plain gearbox.gearIndex). */
function readGearIndex(): number {
  const cur = logic!.currentGearIndex;
  if (cur !== undefined) return nanGuard(cur);
  return nanGuard(gearbox !== undefined ? gearbox.gearIndex : undefined);
}

function isAutoGear(arcade: boolean): boolean {
  if (arcade) return true;
  const getName = logic!.getGearName;
  if (getName === undefined || type(getName) !== "function") return false;
  const [ok, name] = pcall(getName);
  if (!ok || typeof name !== "string") return false;
  const c = string.sub(name, 1, 1);
  return c === "D" || c === "S";
}

function updateGFX(dtIn: number | undefined): void {
  if (dtIn === undefined || !(dtIn > 0)) return;
  const dt = min(dtIn, 0.1);
  clock = clock + dt;
  if (!cfg.enabled) {
    if (logic !== undefined) detach();
    publish(undefined);
    return;
  }

  if (logic === undefined) {
    if (blocked) {
      // another copy owns the shift logic: check once a second whether it let go (e.g. it was unloaded)
      blockedTimer = blockedTimer + dt;
      if (blockedTimer < 1) return;
      blockedTimer = 0;
      const other = findLogic();
      if (other === undefined || !attach(other)) return;
    } else {
      // the controller loads its shift logic during vehicle init; look again for a while if it is not there yet
      if (findTries >= 20 || !(playerInfo.anyPlayerSeated ?? false)) return;
      findTimer = findTimer + dt;
      if (findTimer < 0.5) return;
      findTimer = 0;
      findTries = findTries + 1;
      const found = findLogic();
      if (found === undefined) return;
      if (!attach(found)) return;
    }
  } else if (logic.smoothedValues !== smoothed || logic.timer !== timer || logic.timerConstants !== constants) {
    // the controller rebuilt its tables (re-init): hand the old ones back and take the new ones right away
    const same = logic;
    detach();
    if (type(same.updateGearboxGFX) !== "function" || type(same.smoothedValues) !== "table" || type(same.timer) !== "table" || type(same.timerConstants) !== "table") {
      findTimer = 0.5;
      return;
    }
    if (!attach(same)) return;
  }

  const sm = smoothed!;
  const tm = timer!;
  const tc = constants!;
  const seated = playerInfo.anyPlayerSeated ?? false;
  hookAge = hookAge + dt;
  if (hookAge > 1 && seated && logic!.updateGearboxGFX === hookedUpdate) {
    // the controller is not calling this module any more (the shifter mode was switched): let go of it and look again
    if (!deadLogged) log("W", TAG, "the shift logic [" + logicName + "] stopped running: looking for the active one");
    deadLogged = true;
    deadLogic = logic;
    deadTimer = 0;
    detach();
    findTries = 0;
    findTimer = 0.5;
    publish(undefined);
    return;
  }
  if (deadLogic !== undefined) {
    deadTimer = deadTimer + dt;
    if (deadTimer > 5) deadLogic = undefined;
  }
  if (!humanDriving()) {
    // not driven by a person: stock behaviour
    pendingMode = 0;
    pendingBlockUp = false;
    sm.throttleUpShiftThreshold = origGate;
    tc.neutralSelectionDelay = origNeutral;
    decided = false;
    publish(undefined);
    return;
  }

  tc.neutralSelectionDelay = min(origNeutral ?? cfg.neutralDelay, cfg.neutralDelay);

  const rawGear = readGearIndex();
  if (!gearSeeded) {
    stableGear = rawGear;
    candidateGear = rawGear;
    gearSeeded = true;
  } else if (rawGear === candidateGear) {
    stableGear = rawGear;
  } else if (rawGear !== stableGear) {
    candidateGear = rawGear;
  } else {
    // one frame away from the settled gear and back: ignore it, but say so (diagnostic)
    log("I", TAG, string.format("ignored a one-frame gear blip %d -> %d -> %d", stableGear, candidateGear, rawGear));
    candidateGear = rawGear;
  }
  const gearIndex = stableGear;
  const arcade = logic!.gearboxHandling !== undefined && logic!.gearboxHandling.behavior === "arcade";
  const speed = readSpeed();
  const iv = logic!.inputValues;
  inputs.throttle = clamp(nanGuard(iv !== undefined ? iv.throttle : undefined, nanGuard(electrics.values.throttle_input)), 0, 1);
  inputs.brake = clamp(nanGuard(iv !== undefined ? iv.brake : undefined, nanGuard(electrics.values.brake_input)), 0, 1);
  inputs.speed = speed;
  inputs.gearIndex = gearIndex;
  inputs.arcade = arcade;
  inputs.autoGear = isAutoGear(arcade);
  inputs.avgAV = nanGuard(sm.avgAV);
  const d = decide(cfg, state, inputs, dt, decision);

  // not in the middle of a gear change: the logic would judge the next downshift on a half-blended ratio
  if (d.delayCap >= 0 && logic!.isShifting !== true && tm.gearChangeDelayTimer !== undefined && tm.gearChangeDelayTimer > d.delayCap) {
    tm.gearChangeDelayTimer = d.delayCap;
  }
  sm.throttleUpShiftThreshold = d.gate >= 0 ? max(origGate, d.gate) : origGate;
  if (d.floor > 0 && sm.drivingAggression !== undefined && sm.drivingAggression < d.floor) sm.drivingAggression = d.floor;
  pendingMode = d.avgMode;
  pendingBlockUp = d.blockUp;

  ensureHook();
  logEvents(d, gearIndex, speed);
  decided = true;
  publish(d);
}

// ===== hooks and API ==========================================================================
function init(): void {
  detach();
  loadConfig();
  resetState(state);
  findTries = 0;
  findTimer = 0.5;
  blocked = false;
  blockedTimer = 0;
  coastSince = -1;
  lastGear = 0;
  lastMode = 0;
  gearbox = undefined;
  deadLogic = undefined;
  deadLogged = false;
  gearSeeded = false;
}

function onReset(): void {
  init();
}

export function onExtensionLoaded(): boolean {
  init();
  return true;
}

export function onExtensionUnloaded(): void {
  detach();
  publish(undefined);
}

export const onVehicleLoaded = init;
export { onReset, updateGFX };

export function setEnabled(b: unknown): void {
  enabledOverride = b === true;
  cfg.enabled = enabledOverride;
  if (!cfg.enabled) detach();
  log("I", TAG, cfg.enabled ? "on" : "off");
}

export function toggle(): void {
  setEnabled(!cfg.enabled);
}

export function reloadConfig(): void {
  loadConfig();
}

/** Live tuning, e.g. extensions.quickShift.set("coastAggression", 0.85). Not saved. */
export function set(name: unknown, value: unknown): boolean {
  if (name === "enabled") return false; // use setEnabled (keeps the override)
  return setOption(cfg, name, value);
}

export function getState() {
  return {
    enabled: cfg.enabled,
    attached: logic !== undefined,
    hooked: logic !== undefined && logic.updateGearboxGFX === hookedUpdate,
    coasting: decided && decision.coasting,
    avgMode: decided ? decision.avgMode : 0,
    grace: state.grace,
    origNeutral: origNeutral,
    origGate: origGate,
    cfg: cfg,
  };
}

