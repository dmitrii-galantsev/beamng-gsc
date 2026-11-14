# DriveKit for BeamNG.drive

Three gamepad-driving mods in one package, with one in-game app:

| Module | What it does | Game side |
|---|---|---|
| **AGA steering** | Port of the steering core of [Advanced Gamepad Assist](https://github.com/adam10603/AC-Advanced-Gamepad-Assist) (Assetto Corsa). Keeps the front tyres near peak grip, self-steer catches slides. **Off / Grip / Rally**: in Rally the top of the stick steers past the grip limit (full lock when slow) for FWD/AWD cars. | vehicle Lua `extensions.agaSteering` |
| **Horizon camera** | Dynamic third-person chase camera: spring-follow yaw, slide swing, speed FOV, bumps, shake, roll; right stick orbits and eases back. | camera mode `horizon` |
| **QuickShift** | Automatic gearboxes downshift promptly when you coast or brake and change D ↔ R quickly. Works through the stock shift logic. | vehicle Lua `extensions.quickShift` |

Everything is written in **TypeScript**: the game code compiles to plain LuaJIT with
[TypeScriptToLua](https://typescripttolua.github.io/), and the UI app compiles to a browser script. All of it is tested
headless, without the game.

## Install

1. Download `driveKit.zip` from the releases (or build it: `npm ci && npm run build && npm run package`).
2. Put it in `%LOCALAPPDATA%\BeamNG\BeamNG.drive\current\mods\`.
3. In game: UI Apps → add **DriveKit**.
4. Optional bindings (Options → Controls → Vehicle / Camera): *AGA Steering: Grip / Rally*, *AGA Steering: assist on / off*,
   *AGA Steering: recalibrate*, *QuickShift: on / off*, *DriveKit: Horizon camera*.

Upgrading from the separate mods: remove `mods/agaSteering.zip` and any loose copies of
`lua/vehicle/extensions/auto/agaSteering.lua`, `lua/vehicle/extensions/auto/quickShift.lua`,
`lua/ge/extensions/core/cameraModes/horizon.lua`, `ui/modules/apps/{agaSteering,horizonCam,quickShift}` and
`lua/ge/extensions/core/input/actions/agaSteering.json` from the user folder (loose files override zips).
Settings files (`settings/agaSteering.json`, `settings/quickShift.json`, the `hzc_*` game settings) and key bindings
carry over unchanged.

## The app

- **Strip** (always visible): the steering gauge (green = grip limit, orange = Rally reach, white = wheels). Hover it
  for the OFF / GRIP / RALLY switch, the **CAM** pill (click: switch to the Horizon camera / open its tab) and the
  gearbox pill (gear + what QuickShift is doing), and ⚙.
- **Panel**: tabs **STEER / CAM / SHIFT** with the settings, presets and live numbers, and one **live log** for all
  three modules (can be switched off). Changes apply live and are saved.

## Develop

    npm ci            # TypeScript, TypeScriptToLua, vitest, eslint, AngularJS + jsdom (UI test)
    pip install lupa  # LuaJIT 2.1 for the headless game tests (python3)
    npm test          # typecheck, lint, build, unit, Node/LuaJIT parity, LuaJIT integration, UI test
    npm run build     # dist/lua/... and dist/ui/... (the mod's files)
    npm run package   # dist/driveKit.zip

`node scripts/build.mjs aga` / `quickshift` / `horizon` / `ui` builds one target;
`node scripts/integration.mjs --update <target>` rewrites a target's reference outputs after an intended change.

### Layout

    src/
      core/        shared by every module
        mathx.ts       clamp / lerp / eased clamp / low-pass / interpolation / wrapPi / NaN guards   (pure)
        spring.ts      critically damped spring                                                       (pure)
        settings.ts    settings validation: defaults + types + ranges, live set                       (pure)
        vehicle.ts     vehicle-VM glue: read a settings file, "a person is driving", save + sync cars
      aga/         AGA steering: config, calibration, learn, smooth, steering (pure) + agaSteering.ts (glue)
      horizon/     Horizon camera: rig.ts (pure camera model) + horizon.ts (glue)
      quickshift/  QuickShift: model.ts (pure decisions) + quickShift.ts (glue)
      ui/driveKit/ the in-game app: app.ts (AngularJS directive) + app.html / app.css / app.json / app.png
      types/       typed BeamNG globals: common.d.ts (both Lua VMs), vehicle.d.ts, ge.d.ts, electrics.d.ts
                   (the electrics keys shared by the Lua side and the app), plus src/ui/bng.d.ts (UI bridge)
    tests/
      unit/        vitest, per module + core (pure code under Node, Lua's math via tests/setup/lua-shim.ts)
      parity/      the AGA maths computed under Node and under LuaJIT must agree
      integration/ <module>/harness/*.lua mock-BeamNG scenarios run in LuaJIT, compared with expected/*.txt;
                   AGA is also compared frame by frame, to the last bit, with aga/original/agaSteering.lua
                   (the hand-written Lua it replaced), including the rally-mode variants h2rally / h5rally
      ui/          the compiled app in jsdom + AngularJS against a mock bngApi / StreamsManager
    scripts/       build.mjs (all targets), integration.mjs, package.mjs, luajit.py (LuaJIT 2.1 via lupa)
    mod/           static mod files: input actions (driveKit.json), mod_info
    tsconfig.<target>.json  one per build target; each Lua target only sees the globals of its own VM

### Rules that keep Node and Lua identical

The pure modules run under Node (unit tests) and in LuaJIT (game). Use Lua's `math.*`, never JS `Math`; never test
numbers or strings for truthiness (`0` and `""` are truthy in Lua); no `continue`, bitwise operators or try/catch.
eslint enforces these for `src/**` except the UI app, which is ordinary browser TypeScript. Arrays are 0-based in the
source and 1-based in the generated Lua; TypeScriptToLua converts the indices.

### Public names (do not rename)

Settings keys and files, the `electrics.values.aga*` / `qs*` keys (`src/types/electrics.d.ts`), extension names and
their API (`setMode`, `getMode`, `toggleRally`, `setEnabled`, `toggle`, `reloadConfig`, `recalibrate`, `getState`, `set`,
...), the camera mode name `horizon` and the input action names. The AGA `api` harness fails if the module's shape
changes.

## License

MIT (see `LICENSE`). AGA steering is a port of Advanced Gamepad Assist, MIT, Copyright (c) 2023 Adam D.
(`LICENSE_original_AGA.txt`).
