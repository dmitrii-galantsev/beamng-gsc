// DriveKit in-game app: one strip + one panel for the three DriveKit modules.
//   STEER  AGA gamepad steering    (vehicle Lua extensions.agaSteering, settings/agaSteering.json)
//   CAM    Horizon chase camera    (game-engine camera mode "horizon", game settings hzc_*)
//   SHIFT  QuickShift              (vehicle Lua extensions.quickShift, settings/quickShift.json)
// The shared pieces (settings stores, slider rows, presets, the live log, UI preferences) are defined once at the
// top; each module below is a small description of its settings plus its live-state handling.
//
// Compiled by `npm run build` (tsconfig.ui.json) to dist/ui/modules/apps/driveKit/app.js: a plain browser script
// for BeamNG's UI (CEF + AngularJS 1.x). Tested headless by tests/ui/app.test.mjs.

type Value = boolean | number;
type Settings = Record<string, Value>;
type Fmt = (v: number) => string;
type Tab = "steer" | "cam" | "shift";
type SteerMode = "off" | "grip" | "rally";

/** A slider row; rendered by the one row template in app.html. */
interface Row {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  lo?: string;
  hi?: string;
  fmt: Fmt;
  /** hidden unless true */
  show?: () => boolean;
  /** dimmed and disabled while true, with offText() as the value */
  off?: () => boolean;
  offText?: () => string;
  /** rally-coloured left border */
  accent?: boolean;
}
interface Preset {
  name: string;
  v: Record<string, number>;
}
interface LogEntry {
  id: number;
  tag: Tab;
  t: string;
  msg: string;
  kind: string;
  fresh: boolean;
}
/** What the camera mode streams as the `hzcLive` hook (src/horizon/horizon.ts). */
interface CamLive {
  kmh: number;
  fov: number;
  dist: number;
  lag: number;
  slip: number;
}
/** The electrics stream, as far as the app reads it (published by src/aga and src/quickshift). */
interface Electrics extends AgaElectrics, QsElectrics {
  airspeed?: number;
  wheelspeed?: number;
  gearIndex?: number;
  gear?: number | string;
}

/** Where a store keeps its values. */
interface Backend {
  read(cb: (data: unknown) => void): void;
  write(t: Record<string, unknown>): void;
}
interface StoreOptions<T extends Settings> extends Backend {
  defaults: T;
  /** key -> [label, formatter] for the change log */
  names: Record<string, [string, (v: Value) => string]>;
  /** recompute dependent values (AGA "Stability help") */
  derive?: (c: T) => void;
  /** hide a change from the log */
  skipLog?: (key: string, now: T) => boolean;
  /** last chance to change what is written */
  beforeWrite?: (now: T) => void;
  /** makes the car / camera pick the new values up */
  apply?: () => void;
  savedMsg?: string;
}
interface Store<T extends Settings> {
  /** edited in place by the sliders (never replaced: the rows keep a reference) */
  readonly cfg: T;
  saved: T | undefined;
  snapshot(): T;
  load(done?: (c: T) => void): void;
  save(ms?: number): void;
  reset(): void;
}

angular.module("beamng.apps").directive("driveKit", [
  function () {
    return {
      templateUrl: "/ui/modules/apps/driveKit/app.html",
      replace: true,
      restrict: "EA",
      link: function (scope: angular.IScope & Record<string, unknown>) {
        // ======================================================================== shared helpers
        const timers: ReturnType<typeof setTimeout>[] = [];
        function later(fn: () => void, ms: number): ReturnType<typeof setTimeout> {
          const t = setTimeout(() => scope.$evalAsync(fn), ms);
          timers.push(t);
          return t;
        }
        const num = (v: unknown, alt: number): number => (typeof v === "number" && isFinite(v) ? v : alt);
        const round = (v: number): number => Math.round(v * 1000) / 1000;
        const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
        function assign<T extends object>(dst: T, src: T): void {
          for (const k of Object.keys(dst)) delete (dst as Record<string, unknown>)[k];
          angular.extend(dst, angular.copy(src));
        }
        const fmt = {
          pct: (v: number) => Math.round(v * 100) + "%",
          deg: (v: number) => Math.round(v * 10) / 10 + "°",
          x: (v: number) => (Math.round(v * 100) / 100).toFixed(2) + "×",
          sec: (v: number) => (Math.round(v * 100) / 100).toFixed(2) + " s",
          kmh: (v: number) => Math.round(v * 3.6) + " km/h",
          n2: (v: number) => String(Math.round(v * 100) / 100),
          onoff: (v: Value) => (v === true ? "on" : "off"),
        };
        /** log formatter for a numeric setting */
        const n = (f: Fmt) => (v: Value) => f(Number(v));

        // UI-only preferences (not in any settings file)
        function pref<T>(key: string, def: T): T {
          try {
            const v = window.localStorage.getItem("driveKit." + key);
            return v === null ? def : (JSON.parse(v) as T);
          } catch {
            return def;
          }
        }
        function setPref(key: string, v: unknown): void {
          try {
            window.localStorage.setItem("driveKit." + key, JSON.stringify(v));
          } catch {
            /* storage unavailable: the preference just is not remembered */
          }
        }
        // an object: the checkboxes live inside ng-if blocks (child scopes)
        const ui = { open: pref("open", false), tab: pref<Tab>("tab", "steer"), showLog: pref("log", true) };
        scope.ui = ui;
        scope.setTab = (t: Tab): void => {
          ui.tab = t;
          setPref("tab", t);
        };
        scope.toggleOpen = (tab?: Tab): void => {
          if (tab !== undefined && ui.open && ui.tab !== tab) {
            (scope.setTab as (t: Tab) => void)(tab);
            return;
          }
          ui.open = !ui.open;
          if (tab !== undefined) (scope.setTab as (t: Tab) => void)(tab);
          setPref("open", ui.open);
        };

        // ---- one live log for all modules ----
        const log: LogEntry[] = [];
        scope.log = log;
        let logId = 0;
        function addLog(tag: Tab, msg: string, kind = ""): void {
          if (!ui.showLog) return;
          const d = new Date();
          const p2 = (x: number) => (x < 10 ? "0" : "") + x;
          const entry: LogEntry = { id: ++logId, tag, t: p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds()), msg, kind, fresh: true };
          log.unshift(entry);
          if (log.length > 60) log.length = 60;
          later(() => {
            entry.fresh = false;
          }, 3500);
        }
        scope.clearLog = (): void => {
          log.length = 0;
        };
        scope.setShowLog = (): void => {
          setPref("log", ui.showLog);
          if (!ui.showLog) log.length = 0;
        };

        // ---- settings store: a flat table of booleans and numbers, validated like the Lua side (src/core/settings.ts)
        function makeStore<T extends Settings>(tag: Tab, o: StoreOptions<T>): Store<T> {
          let extra: Record<string, unknown> = {};
          let timer: ReturnType<typeof setTimeout> | undefined;
          function coerce(k: string, v: unknown): Value | undefined {
            const def = o.defaults[k];
            if (typeof def === "number" && typeof v === "string" && v !== "" && !isNaN(+v)) v = +v;
            return typeof v === typeof def && v === v ? (v as Value) : undefined;
          }
          const s: Store<T> = {
            cfg: angular.copy(o.defaults),
            saved: undefined,
            snapshot(): T {
              const out: Settings = {};
              for (const k of Object.keys(o.defaults)) {
                let v: unknown = s.cfg[k];
                const def = o.defaults[k]!;
                if (typeof def === "number") {
                  // range inputs hand back strings
                  let x = parseFloat(String(v));
                  if (isNaN(x)) x = def;
                  v = round(x);
                }
                out[k] = v as Value;
              }
              return out as T;
            },
            load(done) {
              o.read((data) =>
                scope.$evalAsync(() => {
                  const c = angular.copy(o.defaults);
                  extra = {};
                  if (data !== null && typeof data === "object") {
                    for (const [k, raw] of Object.entries(data as Record<string, unknown>)) {
                      if (k in o.defaults) {
                        const v = coerce(k, raw);
                        if (v !== undefined) (c as Settings)[k] = v;
                      } else extra[k] = raw;
                    }
                  }
                  if (o.derive) o.derive(c);
                  assign(s.cfg, c);
                  s.saved = s.snapshot();
                  if (done) done(s.cfg);
                }),
              );
            },
            save(ms = 250) {
              if (o.derive) o.derive(s.cfg);
              if (timer !== undefined) clearTimeout(timer);
              timer = later(writeNow, ms);
            },
            reset() {
              assign(s.cfg, o.defaults);
              s.save();
            },
          };
          function writeNow(): void {
            const now = s.snapshot();
            if (o.beforeWrite) o.beforeWrite(now);
            let changes = 0;
            for (const [k, [label, f]] of Object.entries(o.names)) {
              const before = s.saved !== undefined ? s.saved[k] : undefined;
              if (before === undefined || before === now[k] || (o.skipLog && o.skipLog(k, now))) continue;
              changes++;
              addLog(tag, label + " " + f(before) + " → " + f(now[k]!), "set");
            }
            s.saved = now;
            o.write(angular.extend({}, extra, now) as Record<string, unknown>);
            if (o.apply) o.apply();
            if (changes > 0 && o.savedMsg !== undefined) addLog(tag, o.savedMsg, "save");
          }
          return s;
        }
        // backends
        function jsonFile(path: string): Backend {
          return {
            read: (cb) => bngApi.engineLua('jsonReadFile("' + path + '")', cb),
            // double-encoded: a quoted string literal that is valid in Lua too
            write: (t) => bngApi.engineLua('jsonWriteFile("' + path + '", jsonDecode(' + JSON.stringify(JSON.stringify(t)) + "), true)"),
          };
        }
        function gameSettings(prefix: string, keys: readonly string[]): Backend {
          return {
            read: (cb) => bngApi.engineLua("{" + keys.map((k) => k + ' = settings.getValue("' + prefix + k + '")').join(", ") + "}", cb),
            write: (t) => {
              for (const k of keys) {
                const v = parseFloat(String(t[k]));
                if (!isNaN(v)) bngApi.engineLua('settings.setValue("' + prefix + k + '", ' + v + ")");
              }
            },
          };
        }
        /** the preset whose values all match is highlighted */
        function matchPreset(store: Store<Settings>, presets: readonly Preset[]): string {
          let found = "";
          for (const p of presets) {
            if (Object.keys(p.v).every((k) => Math.abs(parseFloat(String(store.cfg[k])) - p.v[k]!) <= 0.001)) found = p.name;
          }
          return found;
        }
        /** vehicle Lua for the player's car; the extension is `auto_<name>` when it was loaded by hand */
        function carLua(name: string, code: string): void {
          try {
            bngApi.activeObjectLua('local a = rawget(extensions, "' + name + '") or rawget(extensions, "auto_' + name + '") if a then ' + code + " end");
          } catch {
            /* no vehicle */
          }
        }
        type EpisodeDone = (peak: number, sec: string, kmh: number) => void;
        /** a condition that holds for a while is logged once, after it ended (peak value, duration, speed) */
        function episodes() {
          const ep: Record<string, { t0: number; peak: number; kmh: number; last: number } | undefined> = {};
          return (key: string, active: boolean, val: number, kmh: number, minMs: number, minPeak: number, done: EpisodeDone): void => {
            const now = Date.now();
            let e = ep[key];
            if (active) {
              if (!e) e = ep[key] = { t0: now, peak: 0, kmh, last: now };
              if (val > e.peak) {
                e.peak = val;
                e.kmh = kmh;
              }
              e.last = now;
            } else if (e && now - e.last > 350) {
              ep[key] = undefined;
              if (e.last - e.t0 >= minMs && e.peak >= minPeak) done(Math.round(e.peak), ((e.last - e.t0) / 1000).toFixed(1), Math.round(e.kmh));
            }
          };
        }
        // row helpers used by the template
        const rowOff = (r: Row): boolean => r.off !== undefined && r.off();
        scope.rowShown = (r: Row): boolean => r.show === undefined || r.show();
        scope.rowOff = rowOff;
        scope.rowText = (r: Row, cfg: Settings): string => (rowOff(r) && r.offText ? r.offText() : r.fmt(parseFloat(String(cfg[r.key]))));

        // ======================================================================== STEER: AGA steering
        const steer = (() => {
          // same keys and defaults as src/aga/config.ts
          const DEFAULTS = {
            enabled: true, rally: false, rallyKnee: 0.65, rallyExtraDeg: 18,
            applyToKeyboard: false, steeringRate: 0.5, filterSetting: 0.5, useFilter: true,
            targetSlip: 0.95, maxSelfSteerAngle: 90, rateIncreaseWithSpeed: 0.0, selfSteerResponse: 0.37,
            dampingStrength: 0.37, countersteerResponse: 0.2, maxDynamicLimitReduction: 5.0,
            peakSlipDeg: 0, learnPeakSlip: true, calibrate: true, reverseDampingFix: true, velocitySmoothing: 0, debug: false,
          };
          type Cfg = typeof DEFAULTS;
          // same formulas the Lua uses when "Stability help" drives everything (src/aga/config.ts)
          function derived(fIn: unknown) {
            let f = parseFloat(String(fIn));
            if (isNaN(f)) f = 0.5;
            return {
              rateIncreaseWithSpeed: (1.0 - f) * 0.2 - 0.1,
              selfSteerResponse: f * 0.5 + 0.12,
              dampingStrength: f * 0.5 + 0.12,
              maxSelfSteerAngle: 90,
              maxDynamicLimitReduction: 3 * f + 3.5,
              countersteerResponse: (1.0 - f) * 0.2 + 0.1,
              targetSlip: 0.95 - (f - 0.5) * 0.04,
            };
          }
          const DERIVED_KEYS = Object.keys(derived(0.5));
          const st = { seen: false, enabled: 1, rally: 0, active: 0, calibrated: false, calibrating: false, unsupported: false, lock: 0, peak: 0, learn: 0 };
          const disp = { grip: 1, max: 1, out: 0 }; // smoothed gauge values
          const live = { stick: 0, wheel: 0, grip: 0, over: 0, self: 0 }; // numbers under the gauge
          const ui2 = { advanced: false };

          const store = makeStore<Cfg>("steer", {
            ...jsonFile("settings/agaSteering.json"),
            defaults: DEFAULTS,
            names: {
              steeringRate: ["Response", n(fmt.pct)],
              filterSetting: ["Stability help", n(fmt.pct)],
              rallyKnee: ["Grip zone", n(fmt.pct)],
              rallyExtraDeg: ["Over-grip at speed", n((v) => "+" + fmt.deg(v))],
              useFilter: ["Fine-tune", (v) => fmt.onoff(v !== true)],
              selfSteerResponse: ["Self-steer", n(fmt.pct)],
              dampingStrength: ["Yaw damping", n(fmt.pct)],
              countersteerResponse: ["Countersteer freedom", n(fmt.pct)],
              maxDynamicLimitReduction: ["Limit drop in slides", n(fmt.n2)],
              targetSlip: ["Grip target", n(fmt.pct)],
              rateIncreaseWithSpeed: ["Faster with speed", n(fmt.n2)],
              maxSelfSteerAngle: ["Max self-steer", n(fmt.deg)],
              peakSlipDeg: ["Tyre peak", n((v) => (v > 0 ? fmt.deg(v) : "auto"))],
              learnPeakSlip: ["Learn tyres", fmt.onoff],
              calibrate: ["Measure lock on spawn", fmt.onoff],
              applyToKeyboard: ["Keyboard", fmt.onoff],
            },
            derive: (c) => {
              if (c.useFilter) angular.extend(c, derived(c.filterSetting));
            },
            skipLog: (k, now) => now.useFilter && DERIVED_KEYS.includes(k),
            // the mode belongs to the car: never write a stale copy of it
            beforeWrite: (now) => {
              if (st.seen) {
                now.rally = st.rally === 1;
                now.enabled = st.enabled === 1;
              }
            },
            apply: () => carLua("agaSteering", "a.reloadConfig()"),
            savedMsg: "saved, live on the car",
          });

          function mode(): SteerMode {
            const en = st.seen ? st.enabled === 1 : store.cfg.enabled;
            const rally = st.seen ? st.rally === 1 : store.cfg.rally;
            return !en ? "off" : rally ? "rally" : "grip";
          }
          const isRally = (): boolean => mode() === "rally";
          function setMode(m: SteerMode): void {
            st.enabled = m === "off" ? 0 : 1; // optimistic; the electrics stream confirms
            if (m !== "off") st.rally = m === "rally" ? 1 : 0;
            store.cfg.enabled = m !== "off";
            if (m !== "off") store.cfg.rally = m === "rally";
            carLua("agaSteering", 'a.setMode("' + m + '", true)');
          }

          const rows: Row[] = [
            { key: "steeringRate", label: "Response", min: 0.05, max: 1, step: 0.05, lo: "smooth", hi: "instant", fmt: fmt.pct, off: isRally, offText: () => "max in Rally" },
            { key: "filterSetting", label: "Stability help", min: 0, max: 1, step: 0.05, lo: "raw", hi: "catches slides", fmt: fmt.pct, off: () => ui2.advanced, offText: () => "fine-tuned" },
            { key: "rallyKnee", label: "Grip zone", min: 0.4, max: 0.9, step: 0.05, lo: "more over-steer travel", hi: "more precision", fmt: (v) => fmt.pct(v) + " of stick", show: isRally, accent: true },
            { key: "rallyExtraDeg", label: "Over-grip at speed", min: 0, max: 45, step: 1, lo: "calm", hi: "wild", fmt: (v) => "+" + Math.round(v) + "°", show: isRally, accent: true },
          ];
          const advRows: Row[] = [
            { key: "selfSteerResponse", label: "Self-steer", min: 0, max: 1, step: 0.01, fmt: fmt.pct },
            { key: "dampingStrength", label: "Yaw damping", min: 0, max: 1, step: 0.01, fmt: fmt.pct },
            { key: "countersteerResponse", label: "Countersteer freedom", min: 0, max: 1, step: 0.01, fmt: fmt.pct },
            { key: "maxDynamicLimitReduction", label: "Limit drop in slides", min: 0, max: 10, step: 0.1, fmt: (v) => v.toFixed(1) },
            { key: "targetSlip", label: "Grip target", min: 0.8, max: 1.1, step: 0.01, fmt: fmt.pct },
            { key: "rateIncreaseWithSpeed", label: "Faster with speed", min: -0.5, max: 0.5, step: 0.01, fmt: fmt.n2 },
            { key: "maxSelfSteerAngle", label: "Max self-steer", min: 0, max: 90, step: 1, fmt: (v) => Math.round(v) + "°" },
            { key: "peakSlipDeg", label: "Tyre peak", min: 0, max: 14, step: 0.5, fmt: (v) => (v > 0 ? fmt.deg(v) : "auto · " + Math.round(st.learn * 100) + "% learned") },
          ];
          const checks = [
            { key: "learnPeakSlip", label: "Learn tyres" },
            { key: "calibrate", label: "Measure lock on spawn" },
            { key: "applyToKeyboard", label: "Keyboard too" },
          ];

          const track = episodes();
          let prevMode: SteerMode | undefined;
          let prevCal: boolean | undefined;
          function onElectrics(e: Electrics): void {
            if (e.agaEnabled === undefined) {
              st.seen = false;
              return;
            }
            st.seen = true;
            st.enabled = e.agaEnabled;
            st.active = num(e.agaActive, 0);
            st.rally = num(e.agaRally, 0);
            st.calibrated = e.agaCalibrated === 1;
            st.calibrating = e.agaCalibrating === 1;
            st.unsupported = e.agaUnsupported === 1;
            st.lock = num(e.agaLockDeg, 0);
            st.peak = num(e.agaPeakSlip, 0);
            st.learn = num(e.agaLearn, 0);
            const grip = num(e.agaGrip, num(e.agaLimit, 1));
            const max = Math.max(grip, num(e.agaMax, grip));
            const out = num(e.agaOut, 0);
            const stick = num(e.agaStick, 0);
            const self = num(e.agaSelfSteer, 0);
            disp.grip += (grip - disp.grip) * 0.35;
            disp.max += (max - disp.max) * 0.35;
            disp.out += (out - disp.out) * 0.6;
            const lock = st.lock;
            const on = st.active === 2;
            const over = on ? Math.max(0, Math.abs(out) - grip) * lock : 0;
            live.stick = Math.round(Math.abs(stick) * 100);
            live.wheel = Math.round(Math.abs(out) * lock);
            live.grip = Math.round(grip * lock);
            live.over = over >= 1 ? Math.round(over) : 0;
            live.self = Math.round(Math.abs(self) * lock);

            const m = mode();
            if (prevMode !== undefined && m !== prevMode) addLog("steer", "mode " + m.toUpperCase(), "set");
            prevMode = m;
            if (prevCal === false && st.calibrated) addLog("steer", "lock measured " + Math.round(lock) + "°", "save");
            prevCal = st.calibrated;
            const kmh = Math.abs(num(e.airspeed, num(e.wheelspeed, 0))) * 3.6;
            track("over", on && m === "rally" && over >= 2, over, kmh, 200, 3, (peak, sec, v) => addLog("steer", "over grip +" + peak + "° · " + sec + "s · " + v + " km/h", "hot"));
            track("self", on && Math.abs(stick) < 0.15 && Math.abs(self) * lock >= 3, Math.abs(self) * lock, kmh, 200, 4, (peak, sec, v) =>
              addLog("steer", "self-steer " + peak + "° · " + sec + "s · " + v + " km/h"),
            );
            track("counter", on && num(e.agaCounter, 0) > 0.5, Math.abs(out) * lock, kmh, 250, 5, (peak, sec, v) =>
              addLog("steer", "countersteer " + peak + "° · " + sec + "s · " + v + " km/h"),
            );
          }

          return {
            st, disp, live, store, rows, advRows, checks, mode, setMode, onElectrics,
            get advanced() {
              return ui2.advanced;
            },
            save: () => store.save(),
            toggleAdvanced(): void {
              ui2.advanced = !ui2.advanced;
              // switching keeps the current feel: fine-tune sliders start from what the help slider was producing
              if (ui2.advanced) angular.extend(store.cfg, derived(store.cfg.filterSetting));
              store.cfg.useFilter = !ui2.advanced;
              store.save();
            },
            recalibrate(): void {
              carLua("agaSteering", "a.recalibrate()");
              addLog("steer", "recalibrate: stop, stick centred", "set");
            },
            reset(): void {
              store.reset();
              ui2.advanced = false;
              setMode("grip");
              addLog("steer", "reset to defaults", "set");
            },
            status(): string {
              if (!st.seen) return "No vehicle";
              if (st.unsupported) return "Unsupported car";
              if (st.enabled !== 1) return "Off";
              if (st.calibrating) return "Measuring lock…";
              if (st.active === 2) return isRally() ? "Rally" : "Grip";
              if (st.active === 1) return "Waiting for gamepad";
              return "Idle (gamepad only)";
            },
            dot(): Record<string, boolean> {
              if (!st.seen || st.enabled !== 1) return {};
              if (st.unsupported) return { bad: true };
              if (st.calibrating || st.active === 1) return { wait: true };
              return { on: st.active === 2 };
            },
            // gauge: centre = straight ahead, edges = full lock
            zone(x: number): Record<string, string> {
              const v = clamp(x || 0, 0, 1);
              return { left: 50 - v * 50 + "%", width: v * 100 + "%" };
            },
            mark: (): Record<string, string> => ({ left: 50 + clamp(disp.out || 0, -1, 1) * 50 + "%" }),
            load(): void {
              store.load((c) => {
                ui2.advanced = !c.useFilter;
              });
              prevMode = undefined;
              prevCal = undefined;
            },
          };
        })();
        scope.steer = steer;

        // ======================================================================== CAM: Horizon camera
        const cam = (() => {
          // keys of the game settings hzc_<key> read by src/horizon/horizon.ts
          const KEYS = ["dist", "height", "fov", "speed", "drift", "loose", "shake", "roll"] as const;
          const presets: Preset[] = [
            { name: "HORIZON", v: { dist: 1, height: 1, fov: 55, speed: 1, drift: 0.5, loose: 1, shake: 0.5, roll: 1 } },
            { name: "TIGHT", v: { dist: 0.85, height: 0.9, fov: 58, speed: 0.6, drift: 0.3, loose: 0.5, shake: 0.2, roll: 0.5 } },
            { name: "CINEMATIC", v: { dist: 1.25, height: 0.9, fov: 48, speed: 1.5, drift: 0.7, loose: 1.6, shake: 0.8, roll: 1.5 } },
          ];
          const rows: Row[] = [
            { key: "dist", label: "Distance", min: 0.6, max: 2, step: 0.05, lo: "close", hi: "far", fmt: fmt.x },
            { key: "height", label: "Height", min: 0.4, max: 2, step: 0.05, lo: "low", hi: "high", fmt: fmt.x },
            { key: "fov", label: "FOV", min: 40, max: 75, step: 1, lo: "narrow", hi: "wide", fmt: (v) => Math.round(v) + "°" },
            { key: "speed", label: "Speed effect", min: 0, max: 2, step: 0.05, lo: "none", hi: "dramatic", fmt: fmt.pct },
            { key: "drift", label: "Slide follow", min: 0, max: 1, step: 0.05, lo: "follow car", hi: "follow travel", fmt: fmt.pct },
            { key: "loose", label: "Looseness", min: 0.3, max: 2, step: 0.05, lo: "locked", hi: "floaty", fmt: fmt.x },
            { key: "shake", label: "Shake", min: 0, max: 2, step: 0.05, lo: "none", hi: "heavy", fmt: fmt.pct },
            { key: "roll", label: "Roll", min: 0, max: 2, step: 0.05, lo: "flat", hi: "leans", fmt: fmt.pct },
          ];
          const names: StoreOptions<Settings>["names"] = {};
          for (const r of rows) names[r.key] = [r.label, n(r.fmt)];
          // game settings are written immediately (the camera reads them every frame); the log waits until the slider rests
          const backend = gameSettings("hzc_", KEYS);
          const store = makeStore<Settings>("cam", { ...backend, defaults: angular.copy(presets[0]!.v), names });
          const c = {
            presets, rows, store,
            preset: "",
            active: false,
            live: { kmh: 0, fov: 0, dist: 0, lag: 0, slip: 0 },
            save(): void {
              backend.write(store.snapshot()); // live while dragging
              c.preset = matchPreset(store, presets);
              store.save(500);
            },
            applyPreset(p: Preset): void {
              angular.extend(store.cfg, p.v);
              c.preset = p.name;
              addLog("cam", "preset " + p.name, "set");
              backend.write(store.snapshot());
              store.saved = store.snapshot();
            },
            activate(): void {
              bngApi.engineLua('pcall(function() core_camera.setByName(0, "horizon") end)');
              addLog("cam", "camera → horizon", "set");
            },
            load(): void {
              store.load(() => {
                c.preset = matchPreset(store, presets);
              });
            },
            /** the camera only streams its live numbers while asked to (keep-alive) */
            tick(): void {
              bngApi.engineLua('rawset(_G, "hzcLiveT", 2)');
              const on = Date.now() - lastLive < 1000;
              if (on !== c.active) scope.$evalAsync(() => (c.active = on));
            },
          };
          let lastLive = 0;
          scope.$on("hzcLive", (_event, data: CamLive | undefined) => {
            lastLive = Date.now();
            scope.$evalAsync(() => {
              if (data) c.live = data;
              c.active = true;
            });
          });
          return c;
        })();
        scope.cam = cam;

        // ======================================================================== SHIFT: QuickShift
        const shift = (() => {
          // same keys and defaults as src/quickshift/model.ts
          const DEFAULTS = {
            enabled: true, coastAssist: true, reverseAssist: true,
            coastAggression: 0.75, coastDelay: 0.1, coastGate: 0.5, coastMinSpeed: 2, coastGrace: 0.5, downshiftHold: 1.5,
            neutralDelay: 0.1, stopSpeed: 0.7, reverseToDriveMaxSpeed: 3, holdTime: 0.05,
          };
          type Cfg = typeof DEFAULTS;
          const rows: Row[] = [
            { key: "coastAggression", label: "Coast hold", min: 0, max: 1, step: 0.05, lo: "lazy", hi: "eager", fmt: fmt.pct },
            { key: "coastDelay", label: "Shift wait", min: 0, max: 0.5, step: 0.01, lo: "instant", hi: "stock", fmt: fmt.sec },
            { key: "downshiftHold", label: "Hold after downshift", min: 0, max: 5, step: 0.1, lo: "none", hi: "long", fmt: fmt.sec },
            { key: "neutralDelay", label: "D / R wait", min: 0.02, max: 0.5, step: 0.01, lo: "instant", hi: "stock", fmt: fmt.sec },
            { key: "stopSpeed", label: "Counts as stopped", min: 0.1, max: 3, step: 0.1, lo: "dead still", hi: "creeping", fmt: fmt.kmh },
            { key: "reverseToDriveMaxSpeed", label: "R → D while rolling", min: 0, max: 10, step: 0.5, lo: "stopped", hi: "moving", fmt: fmt.kmh },
          ];
          const presets: Preset[] = [
            { name: "GENTLE", v: { coastAggression: 0.55, coastDelay: 0.2, downshiftHold: 1, neutralDelay: 0.25, stopSpeed: 0.4, reverseToDriveMaxSpeed: 1.5 } },
            { name: "QUICK", v: { coastAggression: 0.75, coastDelay: 0.1, downshiftHold: 1.5, neutralDelay: 0.1, stopSpeed: 0.7, reverseToDriveMaxSpeed: 3 } },
            { name: "SNAPPY", v: { coastAggression: 0.9, coastDelay: 0.05, downshiftHold: 2, neutralDelay: 0.05, stopSpeed: 1.2, reverseToDriveMaxSpeed: 5 } },
          ];
          const names: StoreOptions<Cfg>["names"] = { coastAssist: ["Coast assist", fmt.onoff], reverseAssist: ["Reverse assist", fmt.onoff] };
          for (const r of rows) names[r.key] = [r.label, n(r.fmt)];
          const store = makeStore<Cfg>("shift", {
            ...jsonFile("settings/quickShift.json"),
            defaults: DEFAULTS,
            names,
            apply: () => carLua("quickShift", "a.reloadConfig()"),
            savedMsg: "saved, live on the car",
          });
          const st = { seen: false, enabled: true, attached: false, coast: false, reverse: 0, gear: 0 };
          function sendLive(k: keyof Cfg): void {
            const v: unknown = store.cfg[k];
            carLua("quickShift", 'a.set("' + k + '", ' + (typeof v === "boolean" ? String(v) : parseFloat(String(v))) + ")");
          }
          let lastGear: number | undefined;
          let lastCoast = false;
          let lastRev = 0;
          let liftAt = 0;
          const s = {
            rows, presets, store, st,
            preset: "",
            changed(r: Row): void {
              sendLive(r.key as keyof Cfg);
              s.preset = matchPreset(store, presets);
              store.save(300);
            },
            flip(k: "coastAssist" | "reverseAssist"): void {
              store.cfg[k] = !store.cfg[k];
              sendLive(k);
              store.save(300);
            },
            setEnabled(on: boolean): void {
              store.cfg.enabled = on;
              st.enabled = on;
              carLua("quickShift", "a.setEnabled(" + String(on) + ")");
              addLog("shift", on ? "on" : "off (stock shifting)", "set");
              store.save(300);
            },
            applyPreset(p: Preset): void {
              for (const [k, v] of Object.entries(p.v)) {
                (store.cfg as Settings)[k] = v;
                sendLive(k as keyof Cfg);
              }
              s.preset = p.name;
              addLog("shift", "preset " + p.name, "set");
              store.save(300);
            },
            status(): string {
              if (!st.seen) return "No vehicle";
              if (!st.enabled) return "Off: stock shifting";
              if (!st.attached) return "No automatic gearbox found";
              if (st.coast) return "Coasting: holding the gear choice";
              if (st.reverse === 1) return "Reverse help: going into R";
              if (st.reverse === 2) return "Drive help: going into D";
              return "Ready";
            },
            /** strip pill: gear + what QuickShift is doing */
            short(): string {
              if (!st.seen) return "–";
              if (!st.enabled) return "off";
              if (!st.attached) return "n/a";
              const g = st.gear < 0 ? "R" : st.gear === 0 ? "N" : "D" + st.gear;
              return g + (st.coast ? " · coast" : st.reverse === 1 ? " · →R" : st.reverse === 2 ? " · →D" : "");
            },
            onElectrics(e: Electrics): void {
              const now = Date.now();
              st.seen = e.qsEnabled !== undefined;
              if (!st.seen) return;
              const coast = e.qsCoast === 1;
              const rev = num(e.qsReverse, 0);
              const gear = typeof e.gearIndex === "number" ? e.gearIndex : typeof e.gear === "number" ? e.gear : 0;
              const speed = Math.round(num(e.wheelspeed, 0) * 3.6);
              st.enabled = e.qsEnabled === 1;
              st.attached = e.qsAttached === 1;
              st.coast = coast;
              st.reverse = rev;
              st.gear = gear;
              if (coast && !lastCoast) liftAt = now;
              if (lastGear !== undefined && gear !== lastGear) {
                const recent = coast || (liftAt > 0 && now - liftAt < 1500);
                if (gear > 0 && lastGear > 0 && gear < lastGear && recent) {
                  addLog("shift", "downshift " + lastGear + " → " + gear + " · " + ((now - liftAt) / 1000).toFixed(2) + " s after lift · " + speed + " km/h", "down");
                } else if (gear > 0 && lastGear > 0 && gear > lastGear) addLog("shift", "upshift " + lastGear + " → " + gear + " · " + speed + " km/h", "up");
                else if (gear < 0 && lastGear >= 0) addLog("shift", "→ R · " + speed + " km/h", "help");
                else if (gear > 0 && lastGear <= 0) addLog("shift", (lastGear < 0 ? "R → D" : "N → D") + " · " + speed + " km/h", "help");
              }
              if (rev !== lastRev && rev !== 0) addLog("shift", rev === 1 ? "reverse help: R after braking" : "drive help: D while rolling back", "help");
              lastGear = gear;
              lastCoast = coast;
              lastRev = rev;
            },
            load(): void {
              store.load(() => {
                s.preset = matchPreset(store, presets);
              });
              lastGear = undefined;
              lastCoast = false;
              lastRev = 0;
            },
          };
          return s;
        })();
        scope.shift = shift;

        // ======================================================================== wiring
        const streams = ["electrics"];
        if (typeof StreamsManager !== "undefined") StreamsManager.add(streams);
        scope.$on("streamsUpdate", (_event, data: { electrics?: Electrics } | undefined) => {
          const e = data && data.electrics;
          if (!e) return;
          scope.$evalAsync(() => {
            steer.onElectrics(e);
            shift.onElectrics(e);
          });
        });
        const keepAlive = setInterval(cam.tick, 1000);
        scope.$on("$destroy", () => {
          if (typeof StreamsManager !== "undefined") StreamsManager.remove(streams);
          clearInterval(keepAlive);
          timers.forEach(clearTimeout);
        });
        // the player may switch vehicles: re-read the files so the sliders match what that vehicle loads
        scope.$on("VehicleFocusChanged", () => {
          steer.load();
          shift.load();
        });
        steer.load();
        cam.load();
        shift.load();
      },
    };
  },
]);
