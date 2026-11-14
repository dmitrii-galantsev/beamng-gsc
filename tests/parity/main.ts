// Lua-side entry of the parity check (compiled to build/parity/vectors.lua, run in LuaJIT by parity.test.ts).
import { computeVectors } from "./vectors";

const vectors = computeVectors();
const lines: string[] = [];
for (const i of $range(1, vectors.length)) {
  lines[i - 1] = string.format("%.17g", vectors[i - 1]!);
}
print(table.concat(lines, "\n"));
