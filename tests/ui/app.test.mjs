// Headless test of the GSC UI app (ui/gsc): the real app.js / app.html run in jsdom with AngularJS 1.x and a
// mock of the BeamNG UI bridge (bngApi, StreamsManager). Checks what the app shows for given electrics and which Lua it
// sends to the game for clicks and slider moves.
// Usage: node tests/ui/app.test.mjs
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const app = join(root, "dist/ui/modules/apps/gsc"); // the build output (npm run build)

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
const w = dom.window;
w.eval(readFileSync(require.resolve("angular/angular.min.js"), "utf8"));

// ---- mock game ----
const files = {
  "settings/agaSteering.json": { enabled: true, rally: false, steeringRate: "0.7", filterSetting: 0.5, useFilter: true, myKey: 42 },
  "settings/quickShift.json": { enabled: true, coastAggression: 0.75, coastDelay: 0.1, downshiftHold: 1.5, neutralDelay: 0.1, stopSpeed: 0.7, reverseToDriveMaxSpeed: 3 },
};
const gameSettings = { dist: 1, height: 1, fov: 55, speed: 1, drift: 0.5, loose: 1, shake: 0.5, roll: 1 };
const engine = [];
const car = [];
w.bngApi = {
  engineLua(code, cb) {
    engine.push(code);
    let m = /^jsonReadFile\("([^"]+)"\)$/.exec(code);
    if (m && cb) return setTimeout(() => cb(JSON.parse(JSON.stringify(files[m[1]] ?? null))), 1);
    if (code.startsWith("{") && code.includes("settings.getValue") && cb) return setTimeout(() => cb({ ...gameSettings }), 1);
    m = /^jsonWriteFile\("([^"]+)", jsonDecode\((.*)\), true\)$/.exec(code);
    if (m) files[m[1]] = JSON.parse(JSON.parse(m[2]));
  },
  activeObjectLua(code) {
    car.push(code);
  },
};
w.StreamsManager = { add() {}, remove() {} };
w.eval("angular.module('beamng.apps', [])");
w.eval(readFileSync(join(app, "app.js"), "utf8"));

let $root, $compile, el;
w.angular
  .module("beamng.apps")
  .run(["$templateCache", ($tc) => $tc.put("/ui/modules/apps/gsc/app.html", readFileSync(join(app, "app.html"), "utf8"))]);
const injector = w.angular.bootstrap(w.document.body, ["beamng.apps"]);
$root = injector.get("$rootScope");
$compile = injector.get("$compile");

// ---- helpers ----
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = async (ms = 20) => {
  await sleep(ms);
  $root.$digest();
};
const q = (sel) => el[0].querySelector(sel);
const qa = (sel) => [...el[0].querySelectorAll(sel)];
const text = (sel) => (q(sel)?.textContent ?? "").replace(/\s+/g, " ").trim();
const click = (node) => {
  node.dispatchEvent(new w.MouseEvent("click", { bubbles: true }));
};
const byText = (sel, t) => qa(sel).find((n) => n.textContent.replace(/\s+/g, " ").trim() === t);
function electrics(extra) {
  $root.$broadcast("streamsUpdate", {
    electrics: {
      agaEnabled: 1, agaActive: 2, agaRally: 0, agaCalibrated: 1, agaCalibrating: 0, agaUnsupported: 0, agaLockDeg: 30, agaPeakSlip: 7.5, agaLearn: 0.4,
      agaGrip: 0.3, agaMax: 0.3, agaOut: 0.2, agaStick: 0.5, agaSelfSteer: 0, agaCounter: 0,
      qsEnabled: 1, qsAttached: 1, qsCoast: 0, qsReverse: 0, gearIndex: 3, wheelspeed: 20,
      ...extra,
    },
  });
}

let failures = 0;
function check(cond, what) {
  if (!cond) failures++;
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${what}`);
}

// ---- scenario ----
console.log("ui: GSC app (jsdom + AngularJS " + w.angular.version.full + ")");
w.localStorage.clear();
el = $compile("<gsc></gsc>")($root.$new());
w.document.body.appendChild(el[0]);
await flush();
check(engine.some((c) => c === 'jsonReadFile("settings/agaSteering.json")') && engine.some((c) => c === 'jsonReadFile("settings/quickShift.json")'), "loads both settings files");
check(engine.some((c) => c.includes('settings.getValue("hzc_dist")')), "loads the camera settings");
check(!q(".dk-panel"), "panel closed by default");

electrics();
await flush();
check(text(".dk-strip .dk-seg span.sel") === "GRIP", "strip: GRIP selected");
check(text(".p-shift") === "D3", "strip: gearbox pill shows D3");
check(q(".dk-mark").style.left === "60%" || parseFloat(q(".dk-mark").style.left) > 50, "gauge mark right of centre for a right turn");

electrics({ qsCoast: 1 });
await flush();
check(text(".p-shift") === "D3 · coast", "strip: coast shows on the pill");
check(el[0].classList.contains("qs-fire"), "strip: pill highlighted while QuickShift acts");

// mode switch from the strip
click(byText(".dk-strip .dk-seg span", "RALLY"));
await flush();
check(car.at(-1).includes('a.setMode("rally", true)') && car.at(-1).includes('rawget(extensions, "agaSteering")'), "RALLY click calls setMode on the car");
electrics({ agaRally: 1, agaMax: 0.9 });
await flush();
check(el[0].classList.contains("m-rally"), "rally styling once the car confirms");

// open the panel: STEER tab
click(q(".dk-gear"));
await flush();
check(!!q(".dk-panel") && text(".dk-tabs .sel") === "STEER", "gear opens the panel on STEER");
check(text(".tab-steer .dk-status") === "Rally", "STEER status Rally");
check(qa(".tab-steer .dk-row").length === 4, "rally rows (grip zone, over-grip) shown in Rally");
const resp = qa(".tab-steer .dk-row")[0];
check(resp.classList.contains("dim") && resp.querySelector("b").textContent === "max in Rally", "Response is dimmed in Rally");
const stab = qa(".tab-steer .dk-row")[1];
check(stab.querySelector("b").textContent === "50%", "Stability help shows the loaded value");
check(text(".tab-steer .dk-live") .includes("grip 9°"), "live numbers: grip in degrees");

// slider move -> file write + reload on the car + log
const range = stab.querySelector("input");
range.value = "0.8";
range.dispatchEvent(new w.Event("input", { bubbles: true }));
range.dispatchEvent(new w.Event("change", { bubbles: true }));
await flush(400);
const aga = files["settings/agaSteering.json"];
check(aga.filterSetting === 0.8 && aga.myKey === 42 && aga.steeringRate === 0.7, "slider saved; unknown keys kept; string values coerced");
check(aga.rally === true, "the saved file keeps the mode the car reports");
check(Math.abs(aga.selfSteerResponse - (0.8 * 0.5 + 0.12)) < 1e-9, "derived values saved with Stability help");
check(car.some((c) => c.includes("a.reloadConfig()") && c.includes("agaSteering")), "car reloads its config");
check(qa(".dk-log div").some((d) => d.textContent.includes("Stability help 50% → 80%")), "log: the change is listed");
check(qa(".dk-log .g-steer").length > 0, "log: tagged STEER");

// fine-tune
click(q(".tab-steer .dk-more"));
await flush(400);
check(qa(".tab-steer .dk-adv .dk-row").length === 8 && qa(".tab-steer .dk-adv .dk-check").length === 3, "fine-tune shows 8 sliders + 3 checks");
check(files["settings/agaSteering.json"].useFilter === false, "fine-tune turns useFilter off");

// CAM tab
click(byText(".dk-tabs span", "CAM"));
await flush();
check(text(".dk-tabs .sel") === "CAM" && qa(".tab-cam .dk-row").length === 8, "CAM tab: 8 sliders");
check(text(".tab-cam .dk-seg span.sel") === "HORIZON", "CAM: matching preset highlighted");
check(text(".tab-cam .dk-status") === "Not the active camera", "CAM: not active without live data");
engine.length = 0;
click(byText(".tab-cam .dk-seg span", "TIGHT"));
await flush();
check(engine.includes('settings.setValue("hzc_dist", 0.85)') && engine.includes('settings.setValue("hzc_loose", 0.5)'), "CAM preset writes the game settings");
$root.$broadcast("hzcLive", { kmh: 88, fov: 61, dist: 5.2, lag: 4, slip: 12 });
await flush();
check(text(".tab-cam .dk-status") === "Horizon camera" && text(".tab-cam .dk-live").includes("88 km/h"), "CAM: live numbers from the camera");
const camRow = qa(".tab-cam .dk-row")[2].querySelector("input");
camRow.value = "60";
camRow.dispatchEvent(new w.Event("input", { bubbles: true }));
camRow.dispatchEvent(new w.Event("change", { bubbles: true }));
await flush(30);
check(engine.includes('settings.setValue("hzc_fov", 60)'), "CAM slider is live while dragging");
await flush(600);
check(qa(".dk-log .g-cam").some((d) => d.textContent.includes("FOV 58° → 60°")), "CAM: change logged after the slider rests");

// SHIFT tab
click(byText(".dk-tabs span", "SHIFT"));
electrics({ agaRally: 1, qsCoast: 1 });
await flush();
check(qa(".tab-shift .dk-row").length === 6, "SHIFT: 6 sliders (incl. hold after downshift)");
check(text(".tab-shift .dk-status") === "Coasting: holding the gear choice", "SHIFT: status from electrics");
check(text(".tab-shift .dk-seg span.sel") === "ON" && qa(".tab-shift .dk-seg")[1].querySelector(".sel")?.textContent === "QUICK", "SHIFT: ON + QUICK preset");
car.length = 0;
click(byText(".tab-shift .dk-chip", "REVERSE"));
await flush(400);
check(car.some((c) => c.includes('a.set("reverseAssist", false)') && c.includes('rawget(extensions, "quickShift") or rawget(extensions, "auto_quickShift")')), "REVERSE chip sets it live");
check(files["settings/quickShift.json"].reverseAssist === false, "REVERSE chip saved");
const hold = qa(".tab-shift .dk-row")[2];
hold.querySelector("input").value = "2.5";
hold.querySelector("input").dispatchEvent(new w.Event("input", { bubbles: true }));
hold.querySelector("input").dispatchEvent(new w.Event("change", { bubbles: true }));
await flush(400);
check(car.some((c) => c.includes('a.set("downshiftHold", 2.5)')) && files["settings/quickShift.json"].downshiftHold === 2.5, "hold-after-downshift slider: live + saved");
// gear changes -> shift log
electrics({ qsCoast: 1, gearIndex: 3 });
await flush();
electrics({ qsCoast: 1, gearIndex: 2 });
await flush();
check(qa(".dk-log .g-shift").some((d) => d.textContent.includes("downshift 3 → 2")), "SHIFT log: coast downshift");
click(byText(".tab-shift .dk-seg span", "OFF"));
await flush(400);
check(car.some((c) => c.includes("a.setEnabled(false)")) && files["settings/quickShift.json"].enabled === false, "SHIFT OFF");

// live log off
const logBox = q(".dk-logtoggle input");
logBox.checked = false;
logBox.dispatchEvent(new w.Event("change", { bubbles: true }));
click(logBox); // jsdom: a click toggles the checkbox and fires the change ngModel listens to
await flush();
const logOn = JSON.parse(w.localStorage.getItem("gsc.log"));
check(typeof logOn === "boolean", "live log preference stored");

// panel state persists
check(w.localStorage.getItem("gsc.open") === "true" && w.localStorage.getItem("gsc.tab") === '"shift"', "open + tab remembered");

// strip pill opens the matching tab
click(q(".dk-gear"));
await flush();
check(!q(".dk-panel"), "gear closes the panel");
click(q(".p-shift"));
await flush();
check(text(".dk-tabs .sel") === "SHIFT", "gearbox pill opens SHIFT");

if (failures > 0) {
  console.error(`ui: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("ui: all checks pass");
process.exit(0);
