/**
 * Typed declarations for the part of BeamNG.drive's *game-engine* Lua API that the Horizon camera mode uses.
 * Shared globals are in common.d.ts.
 * (Taken from how the "Enhanced Chase Camera" mod uses the camera-mode interface.)
 *
 *   - methods declared inside an interface WITHOUT `this: void` are called with a colon  (veh:getID())
 *   - members declared with `this: void` (and all free functions) are called with a dot    (settings.getValue(...))
 * @noSelfInFile
 */

interface Quat {
  readonly __quat: never;
}
declare function vec3(x: number, y: number, z: number): Vec3;
declare function quatFromDir(dir: Vec3, up: Vec3): Quat;

interface GEVehicle {
  getID(): number;
  /** node position relative to the vehicle position */
  getNodePosition(nodeId: number): Vec3;
  getSpawnWorldOOBBRearPoint(): Vec3;
}

/** What core_camera hands to a camera mode every frame. */
interface CameraData {
  dt: number;
  veh: GEVehicle;
  /** vehicle position, world */
  pos: Vec3;
  vel: Vec3;
  prevVel?: Vec3;
  lookBack?: boolean;
  res: { pos: Vec3; rot: Quat; fov: number; collisionCompatible?: boolean };
}

interface CollisionHelper {
  init(): void;
  update(data: CameraData): void;
}

declare const be: {
  getObjectOOBBCenterXYZ(vehId: number): LuaMultiReturn<[number, number, number]>;
};
declare const settings: {
  getValue(this: void, key: string, def?: unknown): unknown;
};
/** Camera control inputs (right stick / keys), each 0..1. */
declare const MoveManager: {
  yawLeft?: number;
  yawRight?: number;
  pitchUp?: number;
  pitchDown?: number;
  zoomIn?: number;
  zoomOut?: number;
};
