/**
 * BeamNG globals that exist in BOTH Lua VMs (vehicle VM and game-engine VM). VM-specific globals are in
 * vehicle.d.ts (AGA steering, QuickShift) and ge.d.ts (Horizon camera); each build target only sees its own VM.
 *
 * Calling convention matters in Lua, so it is encoded here:
 *   - methods declared inside an interface WITHOUT `this: void` are called with a colon  (obj:getGravity())
 *   - members declared with `this: void` (and all free functions) are called with a dot    (guihooks.message(...))
 * Only what the modules need is declared; anything else is deliberately a compile error.
 * @noSelfInFile
 */

/** BeamNG vec3 (the shared lua/common/mathlib.lua type). */
interface Vec3 {
  x: number;
  y: number;
  z: number;
  set(x: number, y: number, z: number): void;
}

type GraphChannel = [name: string, value: number, scale: number, unit: string];
declare const guihooks: {
  message(this: void, msg: string, ttlSeconds: number, category: string): void;
  graph(this: void, ...channels: GraphChannel[]): void;
  trigger(this: void, name: string, data: unknown): void;
};

/** Virtual file system; absent in test harnesses. */
declare const FS: { readonly fileExists?: (path: string) => boolean } | undefined;

type LogLevel = "D" | "I" | "W" | "E";
declare function log(level: LogLevel, tag: string, msg: string): void;
/** BeamNG's serializer (debug string of any value). */
declare function dumps(value: unknown): string;
/** Returns nil when the file is missing or invalid. */
declare function jsonReadFile(path: string): unknown;
/** Returns false on failure. */
declare function jsonWriteFile(path: string, data: unknown, pretty?: boolean): boolean | undefined;

/** LuaJIT extension (require "table.clear"), global in BeamNG. */
declare namespace table {
  function clear(t: object): void;
}
