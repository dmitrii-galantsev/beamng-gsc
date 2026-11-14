// Package: dist/ (built Lua + UI app) + mod/ (input actions, mod info) + docs -> dist/driveKit.zip, a BeamNG mod
// that goes into <userfolder>/mods/. Run `npm run build` first (npm run package does not rebuild).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { targets } from "./build.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "build/package");
const zip = join(root, "dist/driveKit.zip");

for (const t of Object.values(targets)) {
  if (!existsSync(join(root, "dist", t.out))) throw new Error(`missing dist/${t.out}: run npm run build first`);
}
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(root, "dist/lua"), join(stage, "lua"), { recursive: true });
cpSync(join(root, "dist/ui"), join(stage, "ui"), { recursive: true });
cpSync(join(root, "mod"), stage, { recursive: true });
for (const f of ["README.md", "LICENSE", "LICENSE_original_AGA.txt"]) cpSync(join(root, f), join(stage, f));
rmSync(zip, { force: true });
// python's zipfile: portable (python3 is already needed for the LuaJIT tests), entries relative to the mod root
execFileSync("python3", ["-m", "zipfile", "-c", zip, "lua", "ui", "mod_info", "README.md", "LICENSE", "LICENSE_original_AGA.txt"], { cwd: stage, stdio: "inherit" });
console.log("package: dist/driveKit.zip");
execFileSync("python3", ["-m", "zipfile", "-l", zip], { stdio: "inherit" });
