#!/usr/bin/env python3
"""LuaJIT 2.1 (the VM BeamNG uses) via python-lupa. No lua/luajit binary is needed.

  luajit.py check   FILE.lua            compile only (syntax check), nothing is executed
  luajit.py run     FILE.lua            execute a chunk; print() goes to stdout
  luajit.py harness HARNESS.lua SCRIPT  run one of the BeamNG mock harnesses against SCRIPT
                                        (same substitution as /home/claude/test/run.sh)
  luajit.py difftrace HARNESS.lua A B   run the harness against scripts A and B and compare, frame by frame and
                                        to the last bit, everything both publish after each updateGFX call
"""
import os
import sys

import lupa.luajit21 as L


TRACE_PRELUDE = r"""
local realDofile = dofile
local trace = {}
__TRACE = trace
local function f(x) if type(x) == "number" then return string.format("%.17g", x) end return tostring(x) end
function dofile(p)
  local M = realDofile(p)
  local update = M.updateGFX
  M.updateGFX = function(dt)
    update(dt)
    local ev, st = electrics.values, M.getState()
    trace[#trace + 1] = table.concat({f(ev.steering_input), f(input.steering), f(ev.agaActive), f(ev.agaCalibrating),
      f(ev.agaCalibrated), f(ev.agaUnsupported), f(ev.agaLockDeg), f(ev.agaPeakSlip), f(ev.agaLearn), f(ev.agaLearnWhy),
      f(ev.agaLimit), f(ev.agaSelfSteer), f(st.targetSlip), f(st.learnC0), f(st.learnMuMax), f(st.frontStaticMass),
      f(st.learnSamples), f(st.sign), f(st.zero), f(st.wheelbase), f(ev.agaRally), f(ev.agaOut), f(ev.agaStick),
      f(ev.agaGrip), f(ev.agaMax), f(ev.agaCounter)}, " ")
  end
  return M
end
print = function() end
"""


def harness_source(path: str, script: str) -> str:
    src = open(path).read()
    marker = "local SCRIPT = ..."
    if marker not in src:
        raise SystemExit(f"{path}: no '{marker}' line")
    return src.replace(marker, 'local SCRIPT = "%s"' % script)


def trace(path: str, script: str) -> list:
    rt = L.LuaRuntime()
    rt.execute(TRACE_PRELUDE)
    rt.execute(harness_source(path, script))
    return rt.eval("table.concat(__TRACE, '\\n')").split("\n")


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__, file=sys.stderr)
        return 2
    mode, path = sys.argv[1], os.path.abspath(sys.argv[2])
    rt = L.LuaRuntime()
    if mode == "check":
        err = rt.eval("function(p) local f, e = loadfile(p) return (not f) and e or nil end")(path)
        if err:
            print(f"LuaJIT rejects {path}: {err}", file=sys.stderr)
            return 1
        return 0
    if mode == "run":
        rt.eval("function(p) return dofile(p) end")(path)
        return 0
    if mode == "harness":
        script = os.path.abspath(sys.argv[3])
        os.chdir(os.path.dirname(path))
        rt.execute(harness_source(path, script))
        return 0
    if mode == "difftrace":
        a, b = os.path.abspath(sys.argv[3]), os.path.abspath(sys.argv[4])
        os.chdir(os.path.dirname(path))
        ta, tb = trace(path, a), trace(path, b)
        bad = [i for i, (x, y) in enumerate(zip(ta, tb)) if x != y]
        print(f"frames={len(ta)}/{len(tb)} mismatching={len(bad)}")
        if bad or len(ta) != len(tb) or len(ta) < 100:
            for i in bad[:3]:
                print(f"  frame {i}:\n    A {ta[i]}\n    B {tb[i]}")
            return 1
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
