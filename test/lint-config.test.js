import { test } from "node:test";
import assert from "node:assert/strict";

import eslintConfig from "../eslint.config.js";

test("ESLint ignores vendored agent design references", () => {
  assert.ok(eslintConfig[0].ignores.includes(".agents/**"));
});
