import os from "node:os";
import path from "node:path";

export function getConfig({ env = process.env } = {}) {
  const home = env.ROUGH_CUT_AXI_HOME || path.join(env.HOME || os.homedir(), ".rough-cut-axi");
  const homeDir = path.resolve(home);

  return {
    homeDir,
    projectsDir: path.join(homeDir, "projects"),
    noBrowserOpen: env.ROUGH_CUT_AXI_NO_BROWSER_OPEN === "1",
    port: Number(env.ROUGH_CUT_AXI_PORT || 4388),
    testProjectId: env.ROUGH_CUT_AXI_TEST_PROJECT_ID || "",
    elevenLabsFixtureDir: env.ROUGH_CUT_AXI_ELEVENLABS_FIXTURE_DIR
      ? path.resolve(env.ROUGH_CUT_AXI_ELEVENLABS_FIXTURE_DIR)
      : "",
    elevenLabsApiUrl: env.ROUGH_CUT_AXI_ELEVENLABS_API_URL || "https://api.elevenlabs.io",
    ffmpegBin: env.ROUGH_CUT_AXI_FFMPEG_BIN ? path.resolve(env.ROUGH_CUT_AXI_FFMPEG_BIN) : "ffmpeg",
    ffprobeBin: env.ROUGH_CUT_AXI_FFPROBE_BIN ? path.resolve(env.ROUGH_CUT_AXI_FFPROBE_BIN) : "ffprobe",
  };
}
