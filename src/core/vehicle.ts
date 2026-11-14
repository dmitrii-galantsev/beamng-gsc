// Shared vehicle-Lua glue (runs only in the game's vehicle VM and in the LuaJIT harnesses, never under Node).

/** Parsed settings file, or undefined when it is missing or unreadable (never throws). */
export function readSettingsFile(path: string): unknown {
  let exists = true;
  pcall(() => {
    if (FS && FS.fileExists && !FS.fileExists(path)) exists = false;
  });
  if (!exists) return undefined;
  const [ok, res] = pcall(jsonReadFile, path);
  return ok ? res : undefined;
}

/** A person sits in this car and the AI is not driving it. */
export function humanDriving(): boolean {
  if (!(playerInfo.anyPlayerSeated ?? false)) return false;
  return !(ai !== undefined && ai.isDriving !== undefined && ai.isDriving());
}

/**
 * Merges `patch` into a settings JSON file from the vehicle VM. The write runs in the game engine VM (the vehicle VM
 * cannot write the user folder reliably), then `syncLua` (vehicle Lua) is run on every spawned car.
 * Values must be booleans or numbers.
 */
export function saveSettingsFromVehicle(path: string, patch: Record<string, boolean | number>, syncLua?: string): void {
  let assign = "";
  for (const k in patch) {
    assign = assign + " c." + k + "=" + tostring(patch[k]);
  }
  let cmd = "local p='" + path + "' local c=jsonReadFile(p) or {}" + assign + " jsonWriteFile(p,c,true)";
  if (syncLua !== undefined) cmd = cmd + " be:queueAllObjectLua('" + syncLua + "')";
  pcall(() => {
    obj.queueGameEngineLua(cmd);
  });
}
