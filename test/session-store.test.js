import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createSessionStore } from "../src/session-store.js";

test("session store persists project sessions under the configured home", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-sessions-"));

  try {
    const config = {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
      noBrowserOpen: true,
      testProjectId: "",
    };
    const projectDir = path.join(config.projectsDir, "20260514-120000-demo");

    const store = createSessionStore({ config });
    await store.upsert({
      projectDir,
      url: "http://127.0.0.1:4333",
      status: "open",
    });

    const reloadedStore = createSessionStore({ config });

    assert.deepEqual(await reloadedStore.list(), [
      {
        projectDir,
        url: "http://127.0.0.1:4333",
        status: "open",
      },
    ]);

    await reloadedStore.remove(projectDir);
    assert.deepEqual(await store.list(), []);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});
