// Shared pure scalar helpers for every PadPilot module (AGA steering, Horizon camera, QuickShift).
// No BeamNG access: everything here runs unchanged under Node (unit tests) and LuaJIT (game).
//
// RULES for this and every other "pure" module (they keep Node and Lua semantics identical):
//   * use Lua's `math.*` (a shim provides it under Node), never JS `Math.*`
//   * never rely on truthiness of numbers/strings (0 and "" are truthy in Lua, falsy in JS): compare explicitly
//   * NaN checks are written `x === x` / `!(a > b)` on purpose; do not "simplify" them

const abs = math.abs;
const min = math.min;
const max = math.max;
const huge = math.huge;

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

function clamp01(x: number): number {
  return clamp(x, 0, 1);
}

function sgn(x: number): number {
  return x > 0 ? 1 : x < 0 ? -1 : 0;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Saturated inverse lerp: 0 at a, 1 at b, clamped; 0 for a degenerate range. */
function lerpInvSat(x: number, a: number, b: number): number {
  if (abs(b - a) < 1e-12) return 0;
  return clamp01((x - a) / (b - a));
}

function inverseLerp(a: number, b: number, x: number): number {
  const d = b - a;
  return abs(d) > 1e-60 ? (x - a) / d : 0;
}

/** Replaces nil / non-numbers / NaN / +-inf by `alt` (default 0). */
function nanGuard(x: unknown, alt?: number): number {
  if (typeof x !== "number" || x !== x || x === huge || x === -huge) return alt ?? 0;
  return x;
}

/** A finite, sane number (rejects nil, NaN, +-inf and absurd magnitudes). */
function isNum(x: unknown): x is number {
  return typeof x === "number" && x === x && x > -1e9 && x < 1e9;
}

/** Wraps an angle to [-pi, pi). Written so that JS and Lua modulo semantics give the same result. */
function wrapPi(a: number): number {
  const turn = 2 * math.pi;
  let r = (a + math.pi) % turn;
  if (r < 0) {
    r += turn;
  }
  return r - math.pi;
}

/** Smoothstep of x over [a, b]: 0 below a, 1 above b. */
function sstep(x: number, a: number, b: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

function signedPow(x: number, y: number): number {
  return sgn(x) * abs(x) ** y;
}

/** Clamp with quadratic easing into both limits; `easingWindow` is a fraction of (maxVal - minVal). */
function clampEased(val: number, minVal: number, maxVal: number, easingWindow: number): number {
  const windowScaled = easingWindow * (maxVal - minVal);
  const halfWindowScaled = windowScaled * 0.5;
  const minLow = minVal - halfWindowScaled;
  const minHigh = minVal + halfWindowScaled;
  const maxLow = maxVal - halfWindowScaled;
  const maxHigh = maxVal + halfWindowScaled;
  if (val < minLow) return minVal;
  if (val > maxHigh) return maxVal;
  if (val < minHigh) {
    const t = (val - minLow) / windowScaled;
    return minVal + t * t * halfWindowScaled;
  }
  if (val > maxLow) {
    const t = (val - maxLow - windowScaled) / windowScaled;
    return maxVal - t * t * halfWindowScaled;
  }
  return val;
}

function inverseLerpClampedEased(
  from: number,
  to: number,
  val: number,
  outMin: number,
  outMax: number,
  win: number,
): number {
  return clampEased(inverseLerp(from, to, val), outMin, outMax, win);
}

/** Bag of first-order low-pass states addressed by key. */
type LowpassStates = Record<string | number, number | undefined>;

/** One-pole low-pass kept in `state[key]`; the first sample initialises the state. */
function lowpass(state: LowpassStates, key: string | number, val: number, dt: number, tau: number): number {
  let s = state[key];
  if (s === undefined) {
    state[key] = val;
    return val;
  }
  s = s + (val - s) * min(1, dt / tau);
  state[key] = s;
  return s;
}

/**
 * Odd-symmetric piecewise-linear interpolation of the table (xs -> ys) at |x|, sign restored.
 * xs must be ascending and start at 0; saturates at the last point.
 */
function interp(xs: readonly number[], ys: readonly number[], x: number): number {
  const s = sgn(x);
  x = abs(x);
  const n = xs.length;
  if (x >= xs[n - 1]!) return s * ys[ys.length - 1]!;
  for (let i = 1; i < n; i++) {
    if (x <= xs[i]!) {
      const t = (x - xs[i - 1]!) / max(xs[i]! - xs[i - 1]!, 1e-9);
      return s * lerp(ys[i - 1]!, ys[i]!, t);
    }
  }
  return s * ys[ys.length - 1]!;
}

export {
  isNum,
  wrapPi,
  sstep,
  clamp,
  clamp01,
  sgn,
  lerp,
  lerpInvSat,
  inverseLerp,
  nanGuard,
  signedPow,
  clampEased,
  inverseLerpClampedEased,
  lowpass,
  interp,
};
export type { LowpassStates };
