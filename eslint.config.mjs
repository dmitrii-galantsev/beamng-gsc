// Lint rules that guard the JavaScript <-> Lua semantic gap (TypeScriptToLua keeps Lua semantics for truthiness:
// 0, "" and NaN are truthy in Lua but falsy in JS, so code relying on them would behave differently under the
// Node unit tests than in the game). Plus a ban on JS library globals in the pure modules.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    files: ["src/**/*.ts", "tests/parity/vectors.ts", "tests/parity/main.ts"],
    ignores: ["**/*.d.ts", "src/ui/**"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.test.json", tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/strict-boolean-expressions": [
        "error",
        { allowString: false, allowNumber: false, allowNullableObject: true, allowNullableBoolean: true },
      ],
      "@typescript-eslint/no-floating-promises": "off",
      eqeqeq: ["error", "always"],
      "no-restricted-globals": [
        "error",
        ...["Math", "Number", "Object", "JSON", "Array", "String", "console", "isNaN", "isFinite", "parseFloat", "parseInt"].map((name) => ({
          name,
          message: "Not available in Lua (or translated with different semantics). Use the Lua `math`/`string`/`table` libraries.",
        })),
      ],
      "no-restricted-syntax": [
        "error",
        { selector: "ContinueStatement", message: "`continue` compiles to goto; restructure the loop instead." },
        { selector: "BinaryExpression[operator=/^(\\||&|\\^|<<|>>|>>>)$/]", message: "Bitwise operators are not available in Lua 5.1 / LuaJIT without the bit library." },
        { selector: "TryStatement", message: "Use pcall explicitly; try/catch hides Lua error semantics." },
      ],
    },
  },
  // The UI app runs in the browser (BeamNG's CEF), not in Lua: normal JS globals are fine there.
  {
    files: ["src/ui/**/*.ts"],
    ignores: ["**/*.d.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: "./tsconfig.ui.json", tsconfigRootDir: import.meta.dirname },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      eqeqeq: ["error", "always"],
      "no-var": "error",
      "prefer-const": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
    },
  },
);
