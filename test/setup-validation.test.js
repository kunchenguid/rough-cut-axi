import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import { validateSetup } from "../src/setup-validation.js";
import { saveElevenLabsApiKey } from "../src/auth-store.js";

test("validateSetup reports actionable errors for missing dependencies", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-setup-"));

  try {
    const result = await validateSetup({
      config: {
        homeDir,
        projectsDir: path.join(homeDir, "projects"),
      },
      env: {},
      ffmpegBin: path.join(homeDir, "missing-ffmpeg"),
      ffprobeBin: path.join(homeDir, "missing-ffprobe"),
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [
      {
        code: "missing-ffmpeg",
        message: "ffmpeg is required",
        help: "Install ffmpeg or make sure it is available on PATH",
      },
      {
        code: "missing-ffprobe",
        message: "ffprobe is required",
        help: "Install ffprobe or make sure it is available on PATH",
      },
      {
        code: "missing-elevenlabs-api-key",
        message: "ELEVENLABS_API_KEY is required",
        help: "Run `rough-cut-axi auth elevenlabs --api-key <key>` or set ELEVENLABS_API_KEY in your environment",
      },
    ]);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("validateSetup accepts available tools, API key, and writable project storage", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-setup-ok-"));
  const ffmpegBin = path.join(homeDir, "mock-ffmpeg.js");
  const ffprobeBin = path.join(homeDir, "mock-ffprobe.js");

  try {
    await writeMockSetupTool(ffmpegBin, { encoders: " V..... prores_ks            Apple ProRes\n" });
    await writeMockSetupTool(ffprobeBin);
    const result = await validateSetup({
      config: {
        homeDir,
        projectsDir: path.join(homeDir, "projects"),
      },
      env: { ELEVENLABS_API_KEY: "test-key" },
      ffmpegBin,
      ffprobeBin,
    });

    assert.deepEqual(result, { ok: true, errors: [] });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("validateSetup uses configured ffmpeg and ffprobe binary overrides", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-setup-tools-"));
  const ffmpegBin = path.join(homeDir, "configured-ffmpeg.js");
  const ffprobeBin = path.join(homeDir, "configured-ffprobe.js");

  try {
    await writeMockSetupTool(ffmpegBin, { encoders: " V..... prores_ks            Apple ProRes\n" });
    await writeMockSetupTool(ffprobeBin);
    const result = await validateSetup({
      config: {
        homeDir,
        projectsDir: path.join(homeDir, "projects"),
        ffmpegBin,
        ffprobeBin,
      },
      env: { ELEVENLABS_API_KEY: "test-key" },
    });

    assert.deepEqual(result, { ok: true, errors: [] });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("validateSetup accepts a stored ElevenLabs API key when env is unset", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-setup-auth-"));
  const ffmpegBin = path.join(homeDir, "mock-ffmpeg.js");
  const ffprobeBin = path.join(homeDir, "mock-ffprobe.js");

  try {
    await writeMockSetupTool(ffmpegBin, { encoders: " V..... prores_ks            Apple ProRes\n" });
    await writeMockSetupTool(ffprobeBin);
    const config = {
      homeDir,
      projectsDir: path.join(homeDir, "projects"),
    };
    await saveElevenLabsApiKey({ config, apiKey: "stored-test-key" });

    const result = await validateSetup({
      config,
      env: {},
      ffmpegBin,
      ffprobeBin,
    });

    assert.deepEqual(result, { ok: true, errors: [] });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("validateSetup reports non-writable project storage", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-setup-storage-"));
  const projectsDir = path.join(homeDir, "projects-as-file");
  const ffmpegBin = path.join(homeDir, "mock-ffmpeg.js");
  const ffprobeBin = path.join(homeDir, "mock-ffprobe.js");

  try {
    await writeMockSetupTool(ffmpegBin, { encoders: " V..... prores_ks            Apple ProRes\n" });
    await writeMockSetupTool(ffprobeBin);
    await writeFile(projectsDir, "not a directory");

    const result = await validateSetup({
      config: { homeDir, projectsDir },
      env: { ELEVENLABS_API_KEY: "test-key" },
      ffmpegBin,
      ffprobeBin,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [
      {
        code: "project-storage-not-writable",
        message: `Project storage is not writable: ${projectsDir}`,
        help: "Choose a writable ROUGH_CUT_AXI_HOME or fix directory permissions",
      },
    ]);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("validateSetup accepts any supported final render encoder", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-setup-render-encoder-"));
  const ffmpegBin = path.join(homeDir, "mock-ffmpeg.js");
  const ffprobeBin = path.join(homeDir, "mock-ffprobe.js");

  try {
    await writeMockSetupTool(ffmpegBin, { encoders: " V..... libx264              H.264\n" });
    await writeMockSetupTool(ffprobeBin);
    const result = await validateSetup({
      config: {
        homeDir,
        projectsDir: path.join(homeDir, "projects"),
      },
      env: { ELEVENLABS_API_KEY: "test-key" },
      ffmpegBin,
      ffprobeBin,
    });

    assert.deepEqual(result, { ok: true, errors: [] });
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

test("validateSetup reports missing final render encoder support", async () => {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "rough-cut-axi-setup-render-encoder-missing-"));
  const ffmpegBin = path.join(homeDir, "mock-ffmpeg.js");
  const ffprobeBin = path.join(homeDir, "mock-ffprobe.js");

  try {
    await writeMockSetupTool(ffmpegBin, { encoders: " A..... aac                  AAC\n" });
    await writeMockSetupTool(ffprobeBin);
    const result = await validateSetup({
      config: {
        homeDir,
        projectsDir: path.join(homeDir, "projects"),
      },
      env: { ELEVENLABS_API_KEY: "test-key" },
      ffmpegBin,
      ffprobeBin,
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.errors, [
      {
        code: "missing-render-encoder",
        message: "ffmpeg must support at least one final render encoder",
        help: "Install a full ffmpeg build with libx264, libx265, or prores_ks support",
      },
    ]);
  } finally {
    await rm(homeDir, { force: true, recursive: true });
  }
});

async function writeMockSetupTool(toolPath, { encoders = "" } = {}) {
  await writeFile(
    toolPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes("-encoders")) {
  process.stdout.write(${JSON.stringify(encoders)});
  process.exit(0);
}
process.stdout.write("mock tool version");
`,
  );
  await chmod(toolPath, 0o755);
}
