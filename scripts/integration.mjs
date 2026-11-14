// Integration tests: run each compiled Lua file in LuaJIT 2.1 against its mock-BeamNG harnesses and compare with
//   (1) the stored reference outputs        tests/integration/<target>/expected/<harness>.txt
//   (2) for AGA also, bit for bit on every frame, the Lua that ran in the game before the TypeScript port
//       (tests/integration/aga/original/agaSteering.lua = the oracle)
// Usage: node scripts/integration.mjs [--update] [target ...]      (default: all targets; --update rewrites (1))
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { targets } from "./build.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const luajit = join(root, "scripts/luajit.py");
const args = process.argv.slice(2);
const update = args.includes("--update");
const names = args.filter((a) => !a.startsWith("--"));

/** per-frame oracle comparison (difftrace) for these targets */
const oracles = { aga: "original/agaSteering.lua" };

function run(a) {
  const r = spawnSync("python3", [luajit, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });
  return { ok: r.status === 0, out: r.stdout, err: r.stderr };
}

function firstDiff(a, b) {
  const la = a.split("\n");
  const lb = b.split("\n");
  for (let i = 0; i < Math.max(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return `line ${i + 1}:\n      expected: ${la[i]}\n      actual:   ${lb[i]}`;
  }
  return "";
}

let failed = 0;
for (const name of names.length > 0 ? names : Object.keys(targets)) {
  const dir = join(root, "tests/integration", name);
  const script = join(root, "dist", targets[name].out);
  console.log(`integration: ${name}  (dist/${targets[name].out})`);
  for (const file of readdirSync(join(dir, "harness")).filter((f) => f.endsWith(".lua")).sort()) {
    const h = file.slice(0, -4);
    const harness = join(dir, "harness", file);
    const expectedPath = join(dir, "expected", `${h}.txt`);
    const res = run(["harness", harness, script]);
    if (update && res.ok) writeFileSync(expectedPath, res.out);
    const expected = readFileSync(expectedPath, "utf8");
    const same = res.ok && res.out === expected;
    let traceOk = true;
    let traceMsg = "";
    if (oracles[name] !== undefined) {
      const trace = run(["difftrace", harness, join(dir, oracles[name]), script]);
      traceOk = trace.ok;
      traceMsg = `; vs oracle: ${trace.out.trim().split("\n")[0]}`;
      if (!trace.ok) traceMsg += "\n" + trace.out.trim().split("\n").slice(1).join("\n") + trace.err.trim().split("\n").slice(-4).join("\n");
    }
    const ok = same && traceOk;
    if (!ok) failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${h.padEnd(8)} output ${same ? "identical to reference" : "DIFFERS from reference"}${traceMsg}`);
    if (!res.ok) console.log(res.out.trim().split("\n").slice(-4).join("\n") + "\n" + res.err.trim().split("\n").slice(-6).join("\n"));
    else if (!same) console.log("    " + firstDiff(expected, res.out));
  }
}
if (failed > 0) {
  console.error(`integration: ${failed} harness(es) FAILED`);
  process.exit(1);
}
console.log("integration: all harnesses pass");
