/**
 * Typed declarations for the part of BeamNG.drive's *vehicle-side* Lua API that AGA steering and QuickShift use.
 * Shared globals (Vec3, guihooks, log, json*, FS, table.clear) are in common.d.ts. Calling convention: see there.
 * @noSelfInFile
 */

/** One entry of `wheels.wheels` (wheel data record built from the jbeam). All fields may be missing on odd vehicles. */
interface WheelData {
  /** jbeam wheel name, usually "FL", "FR", "RL", "RR", ... */
  readonly name?: string;
  /** hub node ids (the two ends of the spin axis) */
  readonly node1?: number;
  readonly node2?: number;
  readonly isBroken?: boolean;
  /** vertical tyre load, N */
  readonly downForceRaw?: number;
  /** ground material ids under the tyre; 4 means "no contact on this side" */
  readonly contactMaterialID1?: number;
  readonly contactMaterialID2?: number;
  /** wheel circumferential speed, m/s */
  readonly wheelSpeed?: number;
}

/** A wheel that passed the "has both hub nodes" check in findWheels(). */
interface HubWheel extends WheelData {
  readonly node1: number;
  readonly node2: number;
}

/** The vehicle object (C++ side). All methods are colon-called. */
interface BeamNGVehicleObject {
  getDirectionVector(): Vec3;
  getDirectionVectorUp(): Vec3;
  /** Newer builds only. Never call unguarded: see detectXYZ() in aga/agaSteering.ts. */
  getDirectionVectorXYZ(): LuaMultiReturn<[number, number, number]>;
  /** Newer builds only. Never call unguarded: see detectXYZ() in aga/agaSteering.ts. */
  getDirectionVectorUpXYZ(): LuaMultiReturn<[number, number, number]>;
  getVelocity(): Vec3;
  /** allocation-free variant (present in current game versions, see stock protocols.lua / ai.lua) */
  getVelocityXYZ?(): LuaMultiReturn<[number, number, number]>;
  getNodePosition(nodeId: number): Vec3;
  getNodeVelocityVector(nodeId: number): Vec3;
  /** m/s^2, negative on earth (-9.81) */
  getGravity(): number;
  getStaticFrictionCoef(): number;
  /** runs a Lua chunk in the game-engine VM (next frame) */
  queueGameEngineLua(code: string): void;
}
declare const obj: BeamNGVehicleObject;

interface ElectricsValues extends AgaElectrics, QsElectrics {
  steering_input?: number;
  throttle_input?: number;
  brake_input?: number;
  rpm?: number;
}
declare const electrics: { readonly values: ElectricsValues };

/** Input filter ids (lua/common/filters.lua). */
declare const FILTER_KBD: number;
declare const FILTER_PAD: number;
declare const FILTER_DIRECT: number;
declare const FILTER_KBD2: number;

interface InputAxisState {
  readonly val?: number;
  readonly filter?: number;
}
declare const input: {
  readonly state?: { readonly steering?: InputAxisState };
  /** final steering value consumed by the hydros; we overwrite it */
  steering?: number;
  readonly throttle?: number;
  readonly brake?: number;
};

declare const wheels: { readonly wheels?: LuaTable<number, WheelData | undefined> };

declare const sensors: {
  /** lateral / longitudinal acceleration, m/s^2 (smoothed "2" variants preferred when present) */
  readonly gx?: number;
  readonly gy?: number;
  readonly gx2?: number;
  readonly gy2?: number;
};

declare const playerInfo: { readonly anyPlayerSeated?: boolean };

/** Vehicle AI module; absent in some contexts. */
declare const ai: { readonly isDriving?: (this: void) => boolean } | undefined;

interface PartsTreeNode {
  readonly chosenPartName?: unknown;
  readonly [key: string]: unknown;
}
/** Vehicle data (jbeam result). */
declare const v:
  | {
      readonly config?: {
        readonly model?: string;
        readonly mainPartName?: string;
        readonly partsTree?: PartsTreeNode;
      };
    }
  | undefined;

declare const particles: {
  getMaterialsParticlesTable(this: void): LuaTable<number, { readonly name?: string } | undefined> | undefined;
};

/** The values the stock vehicleController hands to the shift logic module (same tables, shared by reference). */
interface ShiftSmoothedValues {
  throttle?: number;
  brake?: number;
  throttleInput?: number;
  brakeInput?: number;
  drivingAggression?: number;
  throttleUpShiftThreshold?: number;
  avgAV?: number;
}
interface ShiftTimer {
  gearChangeDelayTimer?: number;
  neutralSelectionDelayTimer?: number;
}
interface ShiftTimerConstants {
  gearChangeDelay?: number;
  neutralSelectionDelay?: number;
}
interface ShiftLogicModule {
  /** mark set by the QuickShift copy that hooks this module (see quickShift.ts) */
  qsOwner?: unknown;
  updateGearboxGFX?: (this: void, dt: number) => void;
  smoothedValues?: ShiftSmoothedValues;
  timer?: ShiftTimer;
  timerConstants?: ShiftTimerConstants;
  inputValues?: { throttle?: number; brake?: number };
  gearboxHandling?: { behavior?: string };
  getGearName?: (this: void) => unknown;
  /** gear the logic is in / heading for; every stock logic sets it (0 for N and P) */
  currentGearIndex?: number;
  /** true while a gear change is in progress (automatic: ratio blending, dct: clutch swap) */
  isShifting?: boolean;
  /** set by the controller on the logic it is actually using */
  shiftBehavior?: unknown;
  /** shared table the controller refreshes every frame; wheelSlipShiftUp == false forbids the logic's upshifts */
  shiftPreventionData?: { wheelSlipShiftUp?: boolean; wheelSlipShiftDown?: boolean };
}

interface GearboxDevice {
  readonly gearIndex?: number;
}
declare const powertrain: { getDevice(this: void, name: string): GearboxDevice | undefined };
