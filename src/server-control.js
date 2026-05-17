import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function ensureServer({ config, env, version = "", forceRestart = false }) {
  const baseUrl = `http://127.0.0.1:${config.port}`;
  const existing = await fetchHealth(baseUrl);
  if (existing && !shouldRestartServer(version, existing, forceRestart)) {
    return baseUrl;
  }
  if (existing) {
    await requestShutdown(baseUrl);
    await waitForPortFree(baseUrl, 3000);
  }

  const child = spawn(process.execPath, [resolveBinEntry(), "server", "--port", String(config.port)], {
    detached: true,
    stdio: "ignore",
    env: { ...env, ROUGH_CUT_AXI_NO_BROWSER_OPEN: "1", ROUGH_CUT_AXI_PORT: String(config.port) },
  });
  child.unref();

  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const health = await fetchHealth(baseUrl);
    if (health?.app === "rough-cut-axi" && !shouldRestartServer(version, health)) {
      return baseUrl;
    }
    await delay(100);
  }

  throw new Error("Rough Cut AXI editor server did not start");
}

export function resolveBinEntry() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "rough-cut-axi.js");
}

export function shouldForceRestartForLocalBuild(executablePath, sourceServerExists = localSourceServerExists()) {
  return sourceServerExists && path.resolve(executablePath) === resolveBinEntry();
}

export function shouldRestartServer(currentVersion, healthBody, forceRestart = false) {
  if (!healthBody || typeof healthBody !== "object") {
    return false;
  }
  if (forceRestart && healthBody.app === "rough-cut-axi") {
    return true;
  }
  if (healthBody.app && healthBody.app !== "rough-cut-axi") {
    return false;
  }
  if (typeof healthBody.version !== "string" || healthBody.version === "") {
    return true;
  }

  return healthBody.version !== currentVersion;
}

function localSourceServerExists() {
  return existsSync(fileURLToPath(new URL("./server.js", import.meta.url)));
}

async function fetchHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`);
    if (!response.ok) {
      return null;
    }
    return await response.json();
  } catch {
    return null;
  }
}

async function requestShutdown(baseUrl) {
  try {
    await fetch(`${baseUrl}/shutdown`, { method: "POST" });
  } catch {
    // Best effort: the server may exit before the client receives the response.
  }
}

async function waitForPortFree(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await fetchHealth(baseUrl))) {
      return true;
    }
    await delay(100);
  }

  return false;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
