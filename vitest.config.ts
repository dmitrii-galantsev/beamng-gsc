import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/parity/**/*.test.ts"],
    setupFiles: ["tests/setup/lua-shim.ts"],
  },
});
