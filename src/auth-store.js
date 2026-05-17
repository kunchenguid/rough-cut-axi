import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const AUTH_FILE = "auth.json";

export async function readElevenLabsApiKey({ config, env = process.env }) {
  if (env.ELEVENLABS_API_KEY) {
    return env.ELEVENLABS_API_KEY;
  }

  try {
    const auth = JSON.parse(await readFile(authPath(config), "utf8"));
    return auth.elevenlabsApiKey || "";
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }

    throw error;
  }
}

export async function saveElevenLabsApiKey({ config, apiKey }) {
  await mkdir(config.homeDir, { recursive: true });
  await writeFile(authPath(config), `${JSON.stringify({ elevenlabsApiKey: apiKey }, null, 2)}\n`);
}

function authPath(config) {
  return path.join(config.homeDir, AUTH_FILE);
}
