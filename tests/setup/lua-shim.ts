// The pure modules call Lua's `math` library (and `tonumber`) directly, so the generated Lua contains exactly those
// calls. Under Node this shim provides the same functions. tests/parity proves on every `npm test` that Node + shim
// and LuaJIT produce the same numbers for the AGA maths.
const g = globalThis as unknown as { math: Record<string, unknown>; tonumber: (x: unknown) => number | undefined };
g.math = {
  abs: Math.abs,
  min: Math.min,
  max: Math.max,
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  exp: Math.exp,
  atan2: Math.atan2,
  log10: Math.log10,
  deg: (x: number) => x * (180 / Math.PI), // LuaJIT: x * 57.29577951308232
  rad: (x: number) => x * (Math.PI / 180), // LuaJIT: x * 0.017453292519943295
  huge: Infinity,
  pi: Math.PI,
};
// Lua's tonumber for strings: nil for anything that is not a complete number
g.tonumber = (x: unknown) => {
  if (typeof x === "number") return x;
  if (typeof x !== "string" || x.trim() === "") return undefined;
  const n = Number(x);
  return Number.isNaN(n) ? undefined : n;
};
export {};
