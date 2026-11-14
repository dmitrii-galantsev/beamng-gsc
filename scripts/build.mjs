// Build: TypeScript -> one readable LuaJIT file per module, for BeamNG.
//   1. tstl bundles each target (tsconfig.<target>.json) into build/raw/<name>.lua (single file, runtime helpers inlined)
//   2. the target's attribution header (src/<target>/header.lua) is prepended
//   3. the result is checked for constructs LuaJIT / Lua 5.1 cannot run and loaded once in LuaJIT (syntax check)
//   4. written to dist/<game path>
// Usage: node scripts/build.mjs [target ...]      (default: all targets)
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every Lua file the mod ships. `returnCreate`: BeamNG expects a camera-mode file to return its constructor. */
export const targets = {
  aga: { raw: "agaSteering.lua", out: "lua/vehicle/extensions/auto/agaSteering.lua" },
  quickshift: { raw: "quickShift.lua", out: "lua/vehicle/extensions/auto/quickShift.lua" },
  horizon: { raw: "horizon.lua", out: "lua/ge/extensions/core/cameraModes/horizon.lua", returnCreate: true },
};

/** The UI app: src/ui/gsc/app.ts -> app.js (tsconfig.ui.json), copied with its html/css/json/png. */
const UI_SRC = "src/ui/gsc";
const UI_OUT = "ui/modules/apps/gsc";

function buildUi() {
  execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", join(root, "tsconfig.ui.json")], { stdio: "inherit", cwd: root });
  const js = readFileSync(join(root, "build/ui/ui/gsc/app.js"), "utf8");
  if (/^\s*(import|export)\b/m.test(js)) throw new Error("ui: app.js must be a plain script (no import/export)");
  const out = join(root, "dist", UI_OUT);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "app.js"), js);
  const assets = readdirSync(join(root, UI_SRC)).filter((f) => !f.endsWith(".ts"));
  for (const f of assets) copyFileSync(join(root, UI_SRC, f), join(out, f));
  console.log(`build: dist/${UI_OUT}/  (app.js ${js.split("\n").length} lines + ${assets.join(", ")})`);
}

const forbidden = [
  [/\bgoto\b|::\w+::/, "goto / labels"],
  [/\/\//, "integer division (5.3)"],
  [/<<|>>|[^~]~[^=]|&|\|/, "bitwise operators (5.3)"],
  [/\bbit32\b|\butf8\b|\btable\.(unpack|pack|move)\b|\bmath\.(tointeger|type|ult)\b/, "5.2+/5.3 library functions"],
  [/\bload\s*\(|\bloadstring\s*\(|\bdebug\./, "dynamic code / debug library"],
];

function build(name) {
  if (name === "ui") return buildUi();
  const t = targets[name];
  if (t === undefined) throw new Error(`unknown target ${name} (known: ${Object.keys(targets).join(", ")})`);
  execFileSync(join(root, "node_modules/.bin/tstl"), ["-p", join(root, `tsconfig.${name}.json`)], { stdio: "inherit", cwd: root });

  const header = readFileSync(join(root, `src/${name}/header.lua`), "utf8").trimEnd();
  let body = readFileSync(join(root, "build/raw", t.raw), "utf8").replace(/\r\n/g, "\n").trimStart().trimEnd();
  if (t.returnCreate) {
    const tail = "return ____entry";
    if (!body.endsWith(tail)) throw new Error(`${name}: unexpected bundle tail, cannot rewrite the module return`);
    body = body.slice(0, -tail.length) + "return ____entry.create";
  }
  const lua = header + "\n\n" + body + "\n";

  // portability checks on the code (comments and string literals stripped)
  const code = lua
    .replace(/--\[\[[\s\S]*?\]\]/g, "")
    .replace(/--[^\n]*/g, "")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''");
  const problems = forbidden.filter(([re]) => re.test(code)).map(([, what]) => what);
  if (problems.length > 0) throw new Error(`${name}: generated Lua is not LuaJIT / Lua 5.1 safe: ${problems.join("; ")}`);

  const out = join(root, "dist", t.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, lua);
  // syntax check in the real VM (LuaJIT 2.1 through python-lupa; nothing is executed)
  execFileSync("python3", [join(root, "scripts/luajit.py"), "check", out], { stdio: "inherit" });
  console.log(`build: dist/${t.out}  (${lua.split("\n").length} lines, ${Buffer.byteLength(lua)} bytes)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const names = process.argv.slice(2);
  try {
    for (const n of names.length > 0 ? names : [...Object.keys(targets), "ui"]) build(n);
  } catch (e) {
    console.error("build: " + e.message);
    process.exit(1);
  }
}
