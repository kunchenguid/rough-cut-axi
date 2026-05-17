import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { readElevenLabsApiKey, saveElevenLabsApiKey } from "../src/auth-store.js";

test("ElevenLabs auth storage saves and reads the API key from ROUGH_CUT_AXI_HOME", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-auth-"));

  try {
    await saveElevenLabsApiKey({ config: { homeDir }, apiKey: "stored-test-key" });

    assert.equal(await readElevenLabsApiKey({ config: { homeDir }, env: {} }), "stored-test-key");

    const authFile = await readFile(path.join(homeDir, "auth.json"), "utf8");
    assert.deepEqual(JSON.parse(authFile), { elevenlabsApiKey: "stored-test-key" });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("ElevenLabs auth storage prefers ELEVENLABS_API_KEY over the stored key", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-auth-env-"));

  try {
    await saveElevenLabsApiKey({ config: { homeDir }, apiKey: "stored-test-key" });

    assert.equal(
      await readElevenLabsApiKey({
        config: { homeDir },
        env: { ELEVENLABS_API_KEY: "env-test-key" },
      }),
      "env-test-key",
    );
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});
