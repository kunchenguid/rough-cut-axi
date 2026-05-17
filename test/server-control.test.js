import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveBinEntry, shouldForceRestartForLocalBuild, shouldRestartServer } from "../src/server-control.js";

test("shouldRestartServer only restarts compatible Rough Cut AXI servers", () => {
  assert.equal(shouldRestartServer("1.0.0", null), false);
  assert.equal(shouldRestartServer("1.0.0", { app: "other", version: "0.0.0" }), false);
  assert.equal(shouldRestartServer("1.0.0", { app: "rough-cut-axi", version: "1.0.0" }), false);
  assert.equal(shouldRestartServer("1.0.0", { app: "rough-cut-axi", version: "0.9.0" }), true);
  assert.equal(shouldRestartServer("1.0.0", { app: "rough-cut-axi" }), true);
  assert.equal(shouldRestartServer("1.0.0", { app: "rough-cut-axi", version: "1.0.0" }, true), true);
});

test("shouldForceRestartForLocalBuild only restarts when running the local bin entry", () => {
  assert.equal(shouldForceRestartForLocalBuild(resolveBinEntry(), true), true);
  assert.equal(shouldForceRestartForLocalBuild("/usr/local/bin/rough-cut-axi", true), false);
  assert.equal(shouldForceRestartForLocalBuild(resolveBinEntry(), false), false);
});
