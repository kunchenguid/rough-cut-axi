import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { runAxiCli } from "axi-sdk-js";

import { getConfig } from "./config.js";
import { saveElevenLabsApiKey } from "./auth-store.js";
import { createProject, listProjects, readProjectSummary, writeTimelineExport } from "./project-store.js";
import { validateSetup } from "./setup-validation.js";
import { transcribeProject } from "./transcription.js";
import { applyEditOperation } from "./edit-operations.js";
import { addWordBoundaryTimes } from "./word-boundaries.js";
import { renderTimeline } from "./rendering.js";
import { createSessionStore } from "./session-store.js";
import { startServer } from "./server.js";
import { poll } from "./cli-poll.js";
import { ensureServer, resolveBinEntry, shouldForceRestartForLocalBuild } from "./server-control.js";
import { buildProjectSnapshot, parseSnapshotRange, renderProjectSnapshot } from "./project-snapshot.js";

export { shouldForceRestartForLocalBuild, shouldRestartServer } from "./server-control.js";

export const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const AXI_COMMANDS = new Set(["open", "server", "auth", "transcribe", "poll", "snapshot", "apply", "render", "end"]);

export async function run(args, io) {
  if (args[0] === "--help") {
    writeTopLevelHelp(io);
    return;
  }

  if (args.length > 1 && args.includes("--help")) {
    if (writeCommandHelp(args[0], io)) {
      return;
    }
  }

  if (AXI_COMMANDS.has(args[0])) {
    await runAxiCommand(args, io);
    return;
  }

  if (args[0] === "open") {
    await openProject(args.slice(1), io);
    return;
  }

  if (args[0] === "server") {
    await server(args.slice(1), io);
    return;
  }

  if (args[0] === "auth") {
    await auth(args.slice(1), io);
    return;
  }

  if (args[0] === "transcribe") {
    await transcribe(args.slice(1), io);
    return;
  }

  if (args[0] === "poll") {
    await poll(args.slice(1), io);
    return;
  }

  if (args[0] === "snapshot") {
    await snapshot(args.slice(1), io);
    return;
  }

  if (args[0] === "apply") {
    await apply(args.slice(1), io);
    return;
  }

  if (args[0] === "render") {
    await render(args.slice(1), io);
    return;
  }

  if (args[0] === "end") {
    await end(args.slice(1), io);
    return;
  }

  if (args.length === 1 && args[0] === "--json") {
    await writeHomeState(io, { json: true });
    return;
  }

  if (args[0] === "--json" && args.length > 1) {
    io.stdout.write(`error: unexpected argument for rough-cut-axi: ${args[1]}\n`);
    io.stdout.write("help: rough-cut-axi [--json]\n");
    process.exitCode = 2;
    return;
  }

  if (args[0]?.startsWith("--")) {
    io.stdout.write(`error: unknown option for rough-cut-axi: ${args[0]}\n`);
    io.stdout.write("help: rough-cut-axi [--json]\n");
    process.exitCode = 2;
    return;
  }

  if (args.length > 0) {
    io.stdout.write(`error: unknown command: ${args[0]}\n`);
    io.stdout.write("help: Run `rough-cut-axi --help` to see available commands\n");
    process.exitCode = 2;
    return;
  }

  await writeHomeState(io);
}

async function runAxiCommand(args, io) {
  await runAxiCli({
    description: "Local-first transcript-based video editor for agent-assisted rough cuts",
    argv: args,
    stdout: io.stdout,
    hooks: { binaryNames: ["rough-cut-axi"] },
    topLevelHelp: topLevelHelpText(),
    home: async () => captureCommand(writeHomeState, [], io),
    commands: {
      open: (commandArgs) => captureCommand(openProject, commandArgs, io),
      server: (commandArgs) => captureCommand(server, commandArgs, io),
      auth: (commandArgs) => captureCommand(auth, commandArgs, io),
      transcribe: (commandArgs) => captureCommand(transcribe, commandArgs, io),
      poll: (commandArgs) => captureCommand(poll, commandArgs, io),
      snapshot: (commandArgs) => captureCommand(snapshot, commandArgs, io),
      apply: (commandArgs) => captureCommand(apply, commandArgs, io),
      render: (commandArgs) => captureCommand(render, commandArgs, io),
      end: (commandArgs) => captureCommand(end, commandArgs, io),
    },
    getCommandHelp: (command) => COMMAND_HELP[command]?.join("\n") || null,
    renderUnknownCommand: (command) =>
      `error: unknown command: ${command}\nhelp: Run \`rough-cut-axi --help\` to see available commands\n`,
  });
}

async function captureCommand(command, args, io) {
  let output = "";
  await command(args, {
    ...io,
    stdout: {
      write(value) {
        output += value;
      },
    },
  });
  return output.replace(/\n$/, "");
}

function topLevelHelpText() {
  return [
    "usage: rough-cut-axi [--json]",
    "commands: open, auth, transcribe, poll, apply, snapshot, render, end, server",
    "examples:",
    "  rough-cut-axi",
    "  rough-cut-axi open ./footage-a.mp4 ./footage-b.mp4",
    "  rough-cut-axi poll ~/.rough-cut-axi/projects/<project-id> --json",
    "",
  ].join("\n");
}

async function writeHomeState(io, { json = false } = {}) {
  try {
    if (json) {
      io.stdout.write(`${JSON.stringify(await buildHomeState({ env: io.env }), null, 2)}\n`);
      return;
    }

    io.stdout.write(await renderHomeView({ env: io.env }));
  } catch (error) {
    io.stdout.write(`error: failed to read home state: ${firstErrorLine(error)}\n`);
    io.stdout.write(
      "help: Check that ROUGH_CUT_AXI_HOME contains readable project and session state, then rerun `rough-cut-axi`\n",
    );
    process.exitCode = 1;
  }
}

function writeTopLevelHelp(io) {
  io.stdout.write(
    [
      "usage: rough-cut-axi [--json]",
      "commands: open, auth, transcribe, poll, apply, snapshot, render, end, server",
      "examples:",
      "  rough-cut-axi",
      "  rough-cut-axi open ./footage-a.mp4 ./footage-b.mp4",
      "  rough-cut-axi poll ~/.rough-cut-axi/projects/<project-id> --json",
      "",
    ].join("\n"),
  );
}

function writeCommandHelp(command, io) {
  const help = COMMAND_HELP[command];
  if (!help) {
    return false;
  }

  io.stdout.write(`${help.join("\n")}\n`);
  return true;
}

const COMMAND_HELP = {
  open: [
    "usage: rough-cut-axi open <video-file...>|<project-dir> [--json]",
    "flags:",
    "  --json: emit raw structured JSON",
    "examples:",
    "  rough-cut-axi open ./footage-a.mp4 ./footage-b.mp4",
    "  rough-cut-axi open ~/.rough-cut-axi/projects/<project-id> --json",
    "",
  ],
  auth: [
    "usage: rough-cut-axi auth elevenlabs --api-key <key> [--json]",
    "flags:",
    "  --api-key <key>: store an ElevenLabs API key for transcription",
    "  --json: emit raw structured JSON",
    "examples:",
    "  rough-cut-axi auth elevenlabs --api-key <key> --json",
    "",
  ],
  transcribe: [
    "usage: rough-cut-axi transcribe <project-dir> [--json]",
    "flags:",
    "  --json: emit raw structured JSON",
    "examples:",
    "  rough-cut-axi transcribe ~/.rough-cut-axi/projects/<project-id>",
    "  rough-cut-axi transcribe ~/.rough-cut-axi/projects/<project-id> --json",
    "",
  ],
  poll: [
    "usage: rough-cut-axi poll <project-dir> [--wait] [--timeout-ms <ms>] [--agent-reply <text>] [--json]",
    "flags:",
    "  --wait: compatibility flag; poll waits by default",
    "  --timeout-ms <ms>: optional maximum wait time for tests and debugging",
    "  --agent-reply <text>: record an agent reply and clear queued prompts",
    "  --json: emit raw structured JSON",
    "examples:",
    "  rough-cut-axi poll ~/.rough-cut-axi/projects/<project-id>",
    "  rough-cut-axi poll ~/.rough-cut-axi/projects/<project-id> --json",
    "",
  ],
  apply: [
    "usage: rough-cut-axi apply <project-dir> --ops <ops-json-file> [--approved] [--json]",
    "flags:",
    "  --ops <ops-json-file>: JSON array of edit operations to apply",
    "  --approved: allow broad edit plans with more than three operations",
    "  --json: emit raw structured JSON",
    "examples:",
    "  rough-cut-axi apply ~/.rough-cut-axi/projects/<project-id> --ops ops.json",
    "  rough-cut-axi apply ~/.rough-cut-axi/projects/<project-id> --ops ops.json --approved --json",
    "",
  ],
  snapshot: [
    "usage: rough-cut-axi snapshot <project-dir> [--range <start:end>] [--json]",
    "flags:",
    "  --range <start:end>: filter timeline context by output time",
    "  --json: emit raw structured JSON",
    "examples:",
    "  rough-cut-axi snapshot ~/.rough-cut-axi/projects/<project-id>",
    "  rough-cut-axi snapshot ~/.rough-cut-axi/projects/<project-id> --range 12.4:17.8 --json",
    "",
  ],
  render: [
    "usage: rough-cut-axi render <project-dir> [--json]",
    "flags:",
    "  --json: emit raw structured JSON",
    "output:",
    "  writes renders/final.mov as a ProRes/PCM editing handoff",
    "examples:",
    "  rough-cut-axi render ~/.rough-cut-axi/projects/<project-id>",
    "  rough-cut-axi render ~/.rough-cut-axi/projects/<project-id> --json",
    "",
  ],
  end: [
    "usage: rough-cut-axi end <project-dir> [--json]",
    "flags:",
    "  --json: emit raw structured JSON",
    "examples:",
    "  rough-cut-axi end ~/.rough-cut-axi/projects/<project-id>",
    "",
  ],
  server: [
    "usage: rough-cut-axi server [--port <port>]",
    "flags:",
    "  --port <port>: run the local editor server on a specific port",
    "examples:",
    "  rough-cut-axi server --port 4388",
    "",
  ],
};

async function server(args, io) {
  const portIndex = args.indexOf("--port");
  const port = portIndex === -1 ? getConfig({ env: io.env }).port : Number(args[portIndex + 1]);
  const unknownOption = findUnknownServerOption(args);
  if (unknownOption) {
    io.stdout.write(`error: unknown option for server: ${unknownOption}\n`);
    io.stdout.write("help: rough-cut-axi server [--port <port>]\n");
    process.exitCode = 2;
    return;
  }
  if (!Number.isInteger(port) || port <= 0) {
    io.stdout.write("error: --port must be a positive integer\n");
    io.stdout.write("help: rough-cut-axi server [--port <port>]\n");
    process.exitCode = 2;
    return;
  }

  const localServer = await startServer({ config: getConfig({ env: io.env }), port });
  await localServer.done;
}

function findUnknownServerOption(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      return arg;
    }
  }

  return "";
}

async function end(args, io) {
  const projectDir = args[0] || "";
  const json = args.includes("--json");
  const unknownOption = findUnknownEndOption(args.slice(1));
  const extraArgument = findExtraEndArgument(args.slice(1));
  if (!projectDir || projectDir.startsWith("--")) {
    io.stdout.write("error: rough-cut-axi end requires a project directory\n");
    io.stdout.write("help: rough-cut-axi end <project-dir> [--json]\n");
    process.exitCode = 2;
    return;
  }
  if (unknownOption) {
    io.stdout.write(`error: unknown option for end: ${unknownOption}\n`);
    io.stdout.write("help: rough-cut-axi end <project-dir> [--json]\n");
    process.exitCode = 2;
    return;
  }
  if (extraArgument) {
    io.stdout.write(`error: unexpected argument for end: ${extraArgument}\n`);
    io.stdout.write("help: rough-cut-axi end <project-dir> [--json]\n");
    process.exitCode = 2;
    return;
  }

  try {
    const projectPath = path.resolve(projectDir);
    const store = createSessionStore({ config: getConfig({ env: io.env }) });
    await store.remove(projectPath);
    if (json) {
      io.stdout.write(
        `${JSON.stringify(
          {
            project: path.basename(projectPath),
            session: "ended",
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    io.stdout.write(
      [
        `project: ${path.basename(projectPath)}`,
        "session: ended",
        "help[1]:",
        "  Run `rough-cut-axi` to see current project state",
        "",
      ].join("\n"),
    );
  } catch (error) {
    io.stdout.write(`error: failed to end session: ${firstErrorLine(error)}\n`);
    io.stdout.write(
      "help: Check that ROUGH_CUT_AXI_HOME contains a readable sessions.json, then rerun `rough-cut-axi end <project-dir>`\n",
    );
    process.exitCode = 1;
  }
}

function findUnknownEndOption(args) {
  for (const arg of args) {
    if (arg.startsWith("--") && arg !== "--json") {
      return arg;
    }
  }

  return "";
}

function findExtraEndArgument(args) {
  for (const arg of args) {
    if (arg === "--json" || arg.startsWith("--")) {
      continue;
    }
    return arg;
  }

  return "";
}

async function render(args, io) {
  const projectDir = args[0] || "";
  const json = args.includes("--json");
  const unknownOption = findUnknownRenderOption(args.slice(1));
  const extraArgument = findExtraRenderArgument(args.slice(1));
  if (!projectDir || projectDir.startsWith("--")) {
    io.stdout.write("error: rough-cut-axi render requires a project directory\n");
    io.stdout.write("help: rough-cut-axi render <project-dir> [--json]\n");
    process.exitCode = 2;
    return;
  }
  if (unknownOption) {
    io.stdout.write(`error: unknown option for render: ${unknownOption}\n`);
    io.stdout.write("help: rough-cut-axi render <project-dir> [--json]\n");
    process.exitCode = 2;
    return;
  }
  if (extraArgument) {
    io.stdout.write(`error: unexpected argument for render: ${extraArgument}\n`);
    io.stdout.write("help: rough-cut-axi render <project-dir> [--json]\n");
    process.exitCode = 2;
    return;
  }

  try {
    const result = await renderTimeline({ config: getConfig({ env: io.env }), projectDir });
    if (json) {
      io.stdout.write(
        `${JSON.stringify(
          {
            project: path.basename(path.resolve(projectDir)),
            render: result.target,
            output: result.outputPath,
            segments: result.segmentCount,
            expectedDuration: result.expectedDuration,
            actualDuration: result.actualDuration,
            durationDelta: result.durationDelta,
            durationOk: result.durationOk,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    io.stdout.write(
      [
        `project: ${path.basename(path.resolve(projectDir))}`,
        `render: ${result.target}`,
        `output: ${result.outputPath}`,
        `segments: ${result.segmentCount}`,
        `expected_duration: ${result.expectedDuration}`,
        `actual_duration: ${result.actualDuration}`,
        `duration_delta: ${result.durationDelta}`,
        `duration_ok: ${result.durationOk}`,
        "",
      ].join("\n"),
    );
  } catch (error) {
    io.stdout.write(`error: failed to render project: ${firstErrorLine(error)}\n`);
    io.stdout.write(
      "help: Check that the project directory contains a readable timeline.json, then rerun `rough-cut-axi render <project-dir>`\n",
    );
    process.exitCode = 1;
  }
}

function findUnknownRenderOption(args) {
  for (const arg of args) {
    if (arg.startsWith("--") && arg !== "--json") {
      return arg;
    }
  }

  return "";
}

function findExtraRenderArgument(args) {
  for (const arg of args) {
    if (arg === "--json" || arg.startsWith("--")) {
      continue;
    }
    return arg;
  }

  return "";
}

async function apply(args, io) {
  const projectDir = args[0] || "";
  const opsIndex = args.indexOf("--ops");
  const opsPath = opsIndex === -1 ? "" : args[opsIndex + 1] || "";
  const json = args.includes("--json");
  const approved = args.includes("--approved");
  const unknownOption = findUnknownApplyOption(args.slice(1));
  const extraArgument = findExtraApplyArgument(args.slice(1));
  if (!projectDir || projectDir.startsWith("--") || !opsPath) {
    io.stdout.write("error: rough-cut-axi apply requires a project directory and --ops file\n");
    io.stdout.write("help: rough-cut-axi apply <project-dir> --ops <ops-json-file> [--approved] [--json]\n");
    process.exitCode = 2;
    return;
  }
  if (opsPath.startsWith("--")) {
    io.stdout.write("error: --ops requires a JSON file path\n");
    io.stdout.write("help: rough-cut-axi apply <project-dir> --ops <ops-json-file> [--approved] [--json]\n");
    process.exitCode = 2;
    return;
  }
  if (unknownOption) {
    io.stdout.write(`error: unknown option for apply: ${unknownOption}\n`);
    io.stdout.write("help: rough-cut-axi apply <project-dir> --ops <ops-json-file> [--approved] [--json]\n");
    process.exitCode = 2;
    return;
  }
  if (extraArgument) {
    io.stdout.write(`error: unexpected argument for apply: ${extraArgument}\n`);
    io.stdout.write("help: rough-cut-axi apply <project-dir> --ops <ops-json-file> [--approved] [--json]\n");
    process.exitCode = 2;
    return;
  }

  let operations;
  try {
    operations = JSON.parse(await readFile(path.resolve(opsPath), "utf8"));
    if (!Array.isArray(operations)) {
      throw new Error("--ops file must contain a JSON array of edit operations");
    }
  } catch (error) {
    io.stdout.write(`error: failed to read operations: ${firstErrorLine(error)}\n`);
    io.stdout.write(
      "help: Check that --ops points to a readable JSON array, then rerun `rough-cut-axi apply <project-dir> --ops <ops-json-file>`\n",
    );
    process.exitCode = 1;
    return;
  }

  try {
    const projectPath = path.resolve(projectDir);
    if (operations.length > 3 && !approved) {
      throw new Error("broad edit plans require user approval");
    }

    let project = JSON.parse(await readFile(path.join(projectPath, "project.json"), "utf8"));
    for (const operation of operations) {
      project = applyEditOperation(project, await addWordBoundaryTimes(projectPath, project, operation));
    }

    await writeFile(path.join(projectPath, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
    await writeTimelineExport(projectPath, project);
    if (json) {
      io.stdout.write(
        `${JSON.stringify(
          {
            project: path.basename(projectPath),
            appliedOperations: operations.length,
            timelineFootages: (project.timeline || []).length,
            finalPath: project.render?.finalPath || "renders/final.mov",
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    io.stdout.write(
      [
        `project: ${path.basename(projectPath)}`,
        `applied_operations: ${operations.length}`,
        `timeline_footages: ${(project.timeline || []).length}`,
        `final: ${project.render?.finalPath || "renders/final.mov"}`,
        "help[1]:",
        "  Run `rough-cut-axi poll <project-dir>` to inspect the updated project snapshot",
        "",
      ].join("\n"),
    );
  } catch (error) {
    if (error.message === "broad edit plans require user approval") {
      io.stdout.write(`error: ${error.message}\n`);
      io.stdout.write(
        "help: Run `rough-cut-axi apply <project-dir> --ops <ops-json-file> --approved` after user approval\n",
      );
    } else {
      io.stdout.write(`error: failed to apply operations: ${firstErrorLine(error)}\n`);
      io.stdout.write(
        "help: Check that the project directory contains a readable project.json, then rerun `rough-cut-axi apply <project-dir> --ops <ops-json-file>`\n",
      );
    }
    process.exitCode = 1;
  }
}

function findUnknownApplyOption(args) {
  const knownFlags = new Set(["--ops", "--approved", "--json"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--ops") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--") && !knownFlags.has(arg)) {
      return arg;
    }
  }

  return "";
}

function findExtraApplyArgument(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--ops") {
      index += 1;
      continue;
    }
    if (arg === "--approved" || arg === "--json" || arg.startsWith("--")) {
      continue;
    }
    return arg;
  }

  return "";
}

async function snapshot(args, io) {
  const projectDir = args[0] || "";
  const rangeIndex = args.indexOf("--range");
  const rangeValue = rangeIndex === -1 ? "" : args[rangeIndex + 1] || "";
  const outputRange = rangeIndex === -1 ? null : parseSnapshotRange(rangeValue);
  const json = args.includes("--json");
  const unknownOption = findUnknownSnapshotOption(args.slice(1));
  const unexpectedArgument = findUnexpectedSnapshotArgument(args.slice(1));
  if (!projectDir || projectDir.startsWith("--")) {
    io.stdout.write("error: rough-cut-axi snapshot requires a project directory\n");
    io.stdout.write("help: rough-cut-axi snapshot <project-dir> [--range <start:end>] [--json]\n");
    process.exitCode = 2;
    return;
  }
  if (unknownOption) {
    io.stdout.write(`error: unknown option for snapshot: ${unknownOption}\n`);
    io.stdout.write("help: rough-cut-axi snapshot <project-dir> [--range <start:end>] [--json]\n");
    process.exitCode = 2;
    return;
  }
  if (unexpectedArgument) {
    io.stdout.write(`error: unexpected argument for snapshot: ${unexpectedArgument}\n`);
    io.stdout.write("help: rough-cut-axi snapshot <project-dir> [--range <start:end>] [--json]\n");
    process.exitCode = 2;
    return;
  }
  if (rangeIndex !== -1 && (!rangeValue || rangeValue.startsWith("--"))) {
    io.stdout.write("error: --range requires <start:end>\n");
    io.stdout.write("help: rough-cut-axi snapshot <project-dir> [--range <start:end>] [--json]\n");
    process.exitCode = 2;
    return;
  }
  if (rangeIndex !== -1 && !outputRange) {
    io.stdout.write("error: --range must use <start:end> with start before end\n");
    io.stdout.write("help: rough-cut-axi snapshot <project-dir> --range <start:end>\n");
    process.exitCode = 2;
    return;
  }

  try {
    const projectPath = path.resolve(projectDir);
    const project = JSON.parse(await readFile(path.join(projectPath, "project.json"), "utf8"));
    if (json) {
      io.stdout.write(
        `${JSON.stringify(
          {
            project: path.basename(projectPath),
            snapshot: await buildProjectSnapshot(projectPath, project, { outputRange }),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    const lines = [
      `project: ${path.basename(projectPath)}`,
      ...(await renderProjectSnapshot(projectPath, project, { outputRange })),
      "help[1]:",
      "  Run `rough-cut-axi poll <project-dir>` to inspect queued feedback with this snapshot",
      "",
    ];
    io.stdout.write(lines.join("\n"));
  } catch (error) {
    io.stdout.write(`error: failed to snapshot project: ${firstErrorLine(error)}\n`);
    io.stdout.write(
      "help: Check that the project directory contains a readable project.json, then rerun `rough-cut-axi snapshot <project-dir>`\n",
    );
    process.exitCode = 1;
  }
}

function findUnknownSnapshotOption(args) {
  const knownFlags = new Set(["--range", "--json"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--range") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--") && !knownFlags.has(arg)) {
      return arg;
    }
  }

  return "";
}

function findUnexpectedSnapshotArgument(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--range") {
      index += 1;
      continue;
    }
    if (arg === "--json" || arg.startsWith("--")) {
      continue;
    }
    return arg;
  }

  return "";
}

async function transcribe(args, io) {
  const projectDir = args[0] || "";
  const json = args.includes("--json");
  const unknownOption = findUnknownTranscribeOption(args.slice(1));
  const extraArgument = findExtraTranscribeArgument(args.slice(1));
  if (!projectDir || projectDir.startsWith("--")) {
    io.stdout.write("error: rough-cut-axi transcribe requires a project directory\n");
    io.stdout.write("help: rough-cut-axi transcribe <project-dir> [--json]\n");
    process.exitCode = 2;
    return;
  }
  if (unknownOption) {
    io.stdout.write(`error: unknown option for transcribe: ${unknownOption}\n`);
    io.stdout.write("help: rough-cut-axi transcribe <project-dir> [--json]\n");
    process.exitCode = 2;
    return;
  }
  if (extraArgument) {
    io.stdout.write(`error: unexpected argument for transcribe: ${extraArgument}\n`);
    io.stdout.write("help: rough-cut-axi transcribe <project-dir> [--json]\n");
    process.exitCode = 2;
    return;
  }

  try {
    const result = await transcribeProject({ config: getConfig({ env: io.env }), projectDir });
    if (json) {
      io.stdout.write(
        `${JSON.stringify(
          {
            project: result.projectId,
            written: result.written,
            cached: result.cached,
            transcriptIndexPath: result.transcriptIndexPath,
            packedTranscriptPath: result.packedTranscriptPath,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    io.stdout.write(
      [
        `project: ${result.projectId}`,
        `transcription: ${result.transcription?.status || "completed"}`,
        `transcripts: ${result.written.length} written${result.cached.length > 0 ? `, ${result.cached.length} cached` : ""}`,
        `transcript_index: ${result.transcriptIndexPath}`,
        `packed_transcript: ${result.packedTranscriptPath}`,
        "help[1]:",
        "  Run `rough-cut-axi` to see project state",
        "",
      ].join("\n"),
    );
  } catch (error) {
    io.stdout.write(`error: failed to transcribe project: ${firstErrorLine(error)}\n`);
    io.stdout.write(`${transcribeHelpForError(error)}\n`);
    process.exitCode = 1;
  }
}

function transcribeHelpForError(error) {
  const message = firstErrorLine(error);
  if (message === "ELEVENLABS_API_KEY is required") {
    return "help: Run `rough-cut-axi auth elevenlabs --api-key <key>` or set ELEVENLABS_API_KEY, then rerun `rough-cut-axi transcribe <project-dir>`";
  }
  if (/ffmpeg|ENOENT/.test(message)) {
    return "help: Install ffmpeg or set ROUGH_CUT_AXI_FFMPEG_BIN, then rerun `rough-cut-axi transcribe <project-dir>`";
  }
  if (/ElevenLabs transcription failed/.test(message)) {
    return "help: Check ELEVENLABS_API_KEY, ElevenLabs quota, and footage audio, then rerun `rough-cut-axi transcribe <project-dir>`";
  }
  if (/File size \(\d+\) is greater than 2 GiB/.test(message)) {
    return "help: The footage is too large to buffer directly; install ffmpeg or set ROUGH_CUT_AXI_FFMPEG_BIN so `rough-cut-axi transcribe <project-dir>` can extract audio before upload";
  }

  return "help: Check that the project directory contains a readable project.json, then rerun `rough-cut-axi transcribe <project-dir>`";
}

function findUnknownTranscribeOption(args) {
  for (const arg of args) {
    if (arg.startsWith("--") && arg !== "--json") {
      return arg;
    }
  }

  return "";
}

function findExtraTranscribeArgument(args) {
  return args.find((arg) => !arg.startsWith("--")) || "";
}

async function auth(args, io) {
  if (args[0] !== "elevenlabs") {
    io.stdout.write("error: expected auth provider `elevenlabs`\n");
    io.stdout.write("help: rough-cut-axi auth elevenlabs --api-key <key> [--json]\n");
    process.exitCode = 2;
    return;
  }

  const json = args.includes("--json");
  const apiKeyIndex = args.indexOf("--api-key");
  const apiKey = apiKeyIndex === -1 ? "" : args[apiKeyIndex + 1] || "";
  const unknownOption = findUnknownAuthOption(args.slice(1));
  const extraArgument = findExtraAuthArgument(args.slice(1));
  if (!apiKey || apiKey.startsWith("--")) {
    io.stdout.write("error: --api-key is required\n");
    io.stdout.write("help: rough-cut-axi auth elevenlabs --api-key <key> [--json]\n");
    process.exitCode = 2;
    return;
  }
  if (unknownOption) {
    io.stdout.write(`error: unknown option for auth elevenlabs: ${unknownOption}\n`);
    io.stdout.write("help: rough-cut-axi auth elevenlabs --api-key <key> [--json]\n");
    process.exitCode = 2;
    return;
  }
  if (extraArgument) {
    io.stdout.write(`error: unexpected argument for auth elevenlabs: ${extraArgument}\n`);
    io.stdout.write("help: rough-cut-axi auth elevenlabs --api-key <key> [--json]\n");
    process.exitCode = 2;
    return;
  }

  try {
    await saveElevenLabsApiKey({ config: getConfig({ env: io.env }), apiKey });
    if (json) {
      io.stdout.write(
        `${JSON.stringify(
          {
            auth: "elevenlabs",
            status: "stored",
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    io.stdout.write(["auth: elevenlabs", "status: stored", ""].join("\n"));
  } catch (error) {
    io.stdout.write(`error: failed to store ElevenLabs auth: ${firstErrorLine(error)}\n`);
    io.stdout.write(
      "help: Check that ROUGH_CUT_AXI_HOME is writable, then rerun `rough-cut-axi auth elevenlabs --api-key <key>`\n",
    );
    process.exitCode = 1;
  }
}

function findUnknownAuthOption(args) {
  const knownFlags = new Set(["--api-key", "--json"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--api-key") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--") && !knownFlags.has(arg)) {
      return arg;
    }
  }

  return "";
}

function findExtraAuthArgument(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--api-key") {
      index += 1;
      continue;
    }
    if (arg === "--json" || arg.startsWith("--")) {
      continue;
    }
    return arg;
  }

  return "";
}

async function openProject(footagePaths, io) {
  const json = footagePaths.includes("--json");
  const unknownOption = findUnknownOpenOption(footagePaths);
  footagePaths = footagePaths.filter((footagePath) => footagePath !== "--json");
  if (unknownOption && footagePaths.some((footagePath) => !footagePath.startsWith("--"))) {
    io.stdout.write(`error: unknown option for open: ${unknownOption}\n`);
    io.stdout.write("help: rough-cut-axi open <video-file...>|<project-dir> [--json]\n");
    process.exitCode = 2;
    return;
  }
  if (footagePaths.length === 0 || footagePaths.some((footagePath) => footagePath.startsWith("--"))) {
    io.stdout.write("error: rough-cut-axi open requires at least one video file or project directory\n");
    io.stdout.write("help: rough-cut-axi open <video-file...>|<project-dir> [--json]\n");
    process.exitCode = 2;
    return;
  }

  if (footagePaths.length === 1) {
    let project;
    try {
      project = await findExistingProject(footagePaths[0]);
    } catch (error) {
      io.stdout.write(`error: failed to open project: ${firstErrorLine(error)}\n`);
      io.stdout.write(
        "help: Check that the project directory contains a readable project.json, then rerun `rough-cut-axi open <project-dir>`\n",
      );
      process.exitCode = 1;
      return;
    }
    if (project) {
      await writeProjectOpened(project, io, { json, config: getConfig({ env: io.env }) });
      return;
    }
  }

  const config = getConfig({ env: io.env });
  const setup = await validateSetup({ config, env: io.env });
  if (!setup.ok) {
    for (const error of setup.errors) {
      io.stdout.write(`error: ${error.message}\n`);
      io.stdout.write(`help: ${error.help}\n`);
    }
    process.exitCode = 1;
    return;
  }

  try {
    const project = await createProject({ config, footagePaths });
    await writeProjectOpened(project, io, { json, config });
  } catch (error) {
    io.stdout.write(`error: failed to open project: ${firstErrorLine(error)}\n`);
    io.stdout.write(
      "help: Check that each video path exists and is readable, then rerun `rough-cut-axi open <video-file...>`\n",
    );
    process.exitCode = 1;
  }
}

function findUnknownOpenOption(args) {
  for (const arg of args) {
    if (arg.startsWith("--") && arg !== "--json") {
      return arg;
    }
  }

  return "";
}

function firstErrorLine(error) {
  return (
    String(error.stderr || error.message || error)
      .split("\n")
      .find(Boolean) || "unknown error"
  );
}

async function findExistingProject(projectDir) {
  try {
    return await readProjectSummary({ projectDir });
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return null;
    }

    throw error;
  }
}

async function writeProjectOpened(project, io, { json = false, config = getConfig({ env: io.env }) } = {}) {
  if (json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          project: project.id,
          title: project.title,
          path: project.projectDir,
          footages: project.footageCount,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const session = await openEditorSession({ project, config, env: io.env });
  const transcriptionState = await readProjectTranscriptionState(project.projectDir);
  const nextStep =
    transcriptionState.status === "running"
      ? `Run \`rough-cut-axi poll ${project.projectDir}\` to wait for transcription progress`
      : transcriptionState.needsTranscription
        ? `Run \`rough-cut-axi transcribe ${project.projectDir}\` to create transcripts before asking the agent for edits`
        : `Run \`rough-cut-axi poll ${project.projectDir}\` to wait for queued feedback from the browser editor`;

  io.stdout.write(
    [
      `project: ${project.id}`,
      `title: ${project.title}`,
      `path: ${project.projectDir}`,
      `footages: ${project.footageCount} ${project.footageCount === 1 ? "footage" : "footages"}`,
      "session:",
      `  status: ${session.status}`,
      `  url: ${session.url}`,
      `next_step: ${nextStep}`,
      "help[2]:",
      "  Run `rough-cut-axi transcribe <project-dir>` to transcribe footages",
      "  Run `rough-cut-axi end <project-dir>` to end the editor session",
      "",
    ].join("\n"),
  );
}

async function readProjectTranscriptionState(projectDir) {
  const project = JSON.parse(await readFile(path.join(projectDir, "project.json"), "utf8"));
  if (project.transcription?.status === "running") {
    return { status: "running", needsTranscription: false };
  }

  const footagesWithTranscripts = (project.footages || []).filter((footage) => footage.transcriptPath);
  if (footagesWithTranscripts.length === 0) {
    return { status: project.transcription?.status || "not-needed", needsTranscription: false };
  }

  for (const footage of footagesWithTranscripts) {
    try {
      await readFile(path.join(projectDir, footage.transcriptPath), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return { status: project.transcription?.status || "missing", needsTranscription: true };
      }

      throw error;
    }
  }

  return { status: project.transcription?.status || "completed", needsTranscription: false };
}

async function openEditorSession({ project, config, env }) {
  const baseUrl = await ensureServer({
    config,
    env,
    version: VERSION,
    forceRestart: shouldForceRestartForLocalBuild(process.argv[1] || resolveBinEntry()),
  });
  const url = `${baseUrl}/?project=${encodeURIComponent(project.projectDir)}`;
  const session = { projectDir: project.projectDir, url, status: "open" };
  await createSessionStore({ config }).upsert(session);
  return session;
}

async function renderHomeView({ env = process.env } = {}) {
  const state = await buildHomeState({ env });

  return [
    `bin: ${collapseHome(state.bin)}`,
    `description: ${state.description}`,
    `home: ${collapseHome(state.home)}`,
    `projects: ${state.projects.length} ${state.projects.length === 1 ? "project" : "projects"} found`,
    ...state.projects.map(
      (project) =>
        `  - ${project.id}: ${project.title} (${project.footageCount} ${project.footageCount === 1 ? "footage" : "footages"})`,
    ),
    `sessions: ${state.sessions.length} ${state.sessions.length === 1 ? "active" : "active"}`,
    ...state.sessions.map((session) => `  - ${path.basename(session.projectDir)}: ${session.status} ${session.url}`),
    "help[1]:",
    "  Run `rough-cut-axi open <video-file...>` to create a project",
    "",
  ].join("\n");
}

async function buildHomeState({ env = process.env } = {}) {
  const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "rough-cut-axi.js");
  const config = getConfig({ env });
  return {
    bin: binPath,
    description: "Local-first transcript-based video editor for agent-assisted rough cuts",
    home: config.homeDir,
    projects: await listProjects({ config }),
    sessions: await createSessionStore({ config }).list(),
  };
}

function collapseHome(value) {
  const home = process.env.HOME;
  if (!home || !value.startsWith(`${home}${path.sep}`)) {
    return value;
  }

  return `~${value.slice(home.length)}`;
}
