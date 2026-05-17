import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function createSessionStore({ config }) {
  const filePath = path.join(config.homeDir, "sessions.json");

  return {
    async list() {
      const state = await readState(filePath);
      return state.sessions;
    },

    async upsert(session) {
      const state = await readState(filePath);
      const existingIndex = state.sessions.findIndex((item) => item.projectDir === session.projectDir);
      const nextSession = {
        projectDir: session.projectDir,
        url: session.url,
        status: session.status,
      };

      if (existingIndex === -1) {
        state.sessions.push(nextSession);
      } else {
        state.sessions[existingIndex] = nextSession;
      }

      await writeState(filePath, state);
    },

    async remove(projectDir) {
      const state = await readState(filePath);
      state.sessions = state.sessions.filter((session) => session.projectDir !== projectDir);
      await writeState(filePath, state);
    },
  };
}

async function readState(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return { sessions: [] };
    }

    throw error;
  }
}

async function writeState(filePath, state) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmpPath, filePath);
}
