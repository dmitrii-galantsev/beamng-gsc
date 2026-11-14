// Shared settings validation (pure). Every GSC module keeps its settings as one flat table of booleans and
// numbers with a defaults table and a table of allowed numeric ranges; the UI app and hand-edited JSON files can
// hold anything, so values are validated here the same way for all modules.
import { clamp } from "./mathx";

export type Ranges = Readonly<Record<string, readonly [number, number] | undefined>>;

/**
 * Rebuilds `out` IN PLACE from `defaults` + `data` (the parsed JSON, or anything else). Unknown keys, values of the
 * wrong type and NaN are ignored; a numeric string is accepted for a numeric key (old app versions saved strings).
 * Numeric keys listed in `ranges` are clamped.
 */
export function applySettings(out: object, defaults: object, ranges: Ranges, data: unknown): void {
  const o = out as Record<string, unknown>;
  const defs = defaults as Readonly<Record<string, unknown>>;
  for (const k in defs) {
    o[k] = defs[k];
  }
  if (typeof data === "object" && data !== null) {
    const src = data as Readonly<Record<string, unknown>>;
    for (const k in src) {
      let val = src[k];
      const def = defs[k];
      if (def !== undefined && typeof def === "number" && typeof val === "string") {
        val = tonumber(val);
      }
      if (def !== undefined && typeof val === typeof def && val === val) {
        o[k] = val;
      }
    }
  }
  clampRanges(out, ranges);
}

/** Clamps every numeric key listed in `ranges`. */
export function clampRanges(out: object, ranges: Ranges): void {
  const nums = out as Record<string, number>;
  for (const k in ranges) {
    const r = ranges[k]!;
    nums[k] = clamp(nums[k]!, r[0], r[1]);
  }
}

/**
 * Live change of one setting (not saved): the value must have the default's type; numbers are clamped.
 * Returns false for an unknown key or a bad value.
 */
export function setSetting(out: object, defaults: object, ranges: Ranges, name: unknown, value: unknown): boolean {
  if (typeof name !== "string") return false;
  const def = (defaults as Readonly<Record<string, unknown>>)[name];
  if (def === undefined || typeof value !== typeof def || value !== value) return false;
  const o = out as Record<string, unknown>;
  const r = ranges[name];
  o[name] = r !== undefined && typeof value === "number" ? clamp(value, r[0], r[1]) : value;
  return true;
}
