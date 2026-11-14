import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { computeVectors } from "./vectors";

const bundle = "build/parity/vectors.lua";

describe("Node (unit-test runtime) vs LuaJIT (game runtime)", () => {
  it("the pure modules produce the same numbers in both", () => {
    expect(existsSync(bundle), `${bundle} missing - run "npm run build:parity" (npm test does)`).toBe(true);
    const stdout = execFileSync("python3", ["scripts/luajit.py", "run", bundle], { encoding: "utf8", maxBuffer: 1 << 28 });
    const lua = stdout.trim().split("\n").map((s) => (s.includes("nan") ? NaN : s === "inf" ? Infinity : s === "-inf" ? -Infinity : Number(s)));
    const node = computeVectors();

    expect(node.length).toBeGreaterThan(40000);
    expect(lua.length).toBe(node.length);
    let exact = 0;
    let worst = 0;
    let worstAt = -1;
    for (let i = 0; i < node.length; i++) {
      const a = node[i]!;
      const b = lua[i]!;
      if (Object.is(a, b) || (a === 0 && b === 0)) {
        exact++;
        continue;
      }
      // libm vs V8 may differ in the last bits of sin / atan2 / log10 / pow; nothing else is allowed to differ
      const err = Number.isNaN(a) || Number.isNaN(b) ? Infinity : Math.abs(a - b) / Math.max(1, Math.abs(a));
      if (err > worst) {
        worst = err;
        worstAt = i;
      }
    }
    console.log(`parity: ${node.length} values, ${exact} bit-identical, worst relative difference ${worst.toExponential(2)}`);
    expect(worst, `value #${worstAt}: node ${node[worstAt]} vs lua ${lua[worstAt]}`).toBeLessThan(1e-12);
  });
});
