import { watch } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildProjectSnapshot, renderProjectSnapshot, summarizeTarget } from "./project-snapshot.js";

const POLL_USAGE = "rough-cut-axi poll <project-dir> [--wait] [--timeout-ms <ms>] [--agent-reply <text>] [--json]";

export async function poll(args, io) {
  const projectDir = args[0] || "";
  const agentReplyIndex = args.indexOf("--agent-reply");
  const agentReply = agentReplyIndex === -1 ? "" : args[agentReplyIndex + 1] || "";
  const json = args.includes("--json");
  const timeoutIndex = args.indexOf("--timeout-ms");
  const timeoutMs = timeoutIndex === -1 ? null : Number(args[timeoutIndex + 1]);
  const unknownOption = findUnknownPollOption(args.slice(1));
  const extraArgument = findExtraPollArgument(args.slice(1));
  if (!projectDir || projectDir.startsWith("--")) {
    io.stdout.write("error: rough-cut-axi poll requires a project directory\n");
    io.stdout.write(`help: ${POLL_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (unknownOption) {
    io.stdout.write(`error: unknown option for poll: ${unknownOption}\n`);
    io.stdout.write(`help: ${POLL_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (extraArgument) {
    io.stdout.write(`error: unexpected argument for poll: ${extraArgument}\n`);
    io.stdout.write(`help: ${POLL_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (agentReplyIndex !== -1 && (agentReply.trim() === "" || agentReply.startsWith("--"))) {
    io.stdout.write("error: --agent-reply requires text\n");
    io.stdout.write(`help: ${POLL_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (timeoutIndex !== -1 && (!args[timeoutIndex + 1] || args[timeoutIndex + 1].startsWith("--"))) {
    io.stdout.write("error: --timeout-ms requires <ms>\n");
    io.stdout.write(`help: ${POLL_USAGE}\n`);
    process.exitCode = 2;
    return;
  }
  if (timeoutIndex !== -1 && (!Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    io.stdout.write("error: --timeout-ms must be a non-negative number\n");
    io.stdout.write(`help: ${POLL_USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    const projectPath = path.resolve(projectDir);
    const projectFile = path.join(projectPath, "project.json");
    let project = JSON.parse(await readFile(projectFile, "utf8"));
    const replyRecorded = agentReply.trim() !== "";
    if (replyRecorded) {
      project = {
        ...project,
        chat: {
          ...project.chat,
          pendingPrompts: [],
          messages: [
            ...(Array.isArray(project.chat?.messages) ? project.chat.messages : []),
            { role: "agent", text: agentReply.trim() },
          ],
          agentPresence: "waiting",
        },
      };
      await writeFile(projectFile, `${JSON.stringify(project, null, 2)}\n`);
    } else if (project.transcription?.status === "running") {
      project = await waitForTranscription(projectFile, timeoutMs);
      if (shouldReportTranscription(project)) {
        await writePollTranscriptionOutput({ projectPath, project, json, io });
        return;
      }
    }
    if (!replyRecorded && getPendingPrompts(project).length === 0) {
      project = await writeProjectPresence(projectFile, project, "listening");
      project = await waitForQueuedPrompts(projectFile, timeoutMs);
      if (getPendingPrompts(project).length === 0 && project.chat?.agentPresence === "listening") {
        project = await writeProjectPresence(projectFile, project, "waiting");
      }
    }
    if (!replyRecorded && shouldReportTranscription(project)) {
      await writePollTranscriptionOutput({ projectPath, project, json, io });
      return;
    }
    let pendingPrompts = getPendingPrompts(project);
    if (!replyRecorded && pendingPrompts.length > 0 && project.chat?.agentPresence !== "working") {
      project = {
        ...project,
        chat: {
          ...project.chat,
          agentPresence: "working",
        },
      };
      await writeFile(projectFile, `${JSON.stringify(project, null, 2)}\n`);
      pendingPrompts = getPendingPrompts(project);
    }
    if (json) {
      io.stdout.write(
        `${JSON.stringify(
          {
            project: path.basename(projectPath),
            title: project.title,
            ...(replyRecorded ? { agentReply: "recorded" } : {}),
            presence: project.chat?.agentPresence || "waiting",
            pendingPrompts,
            snapshot: await buildProjectSnapshot(projectPath, project),
          },
          null,
          2,
        )}\n`,
      );
      return;
    }

    const lines = [
      `project: ${path.basename(projectPath)}`,
      `title: ${project.title}`,
      ...(replyRecorded ? ["agent_reply: recorded"] : []),
      `presence: ${project.chat?.agentPresence || "waiting"}`,
      `pending_prompts[${pendingPrompts.length}]{uid,tag,prompt,target}:`,
    ];

    for (const prompt of pendingPrompts) {
      lines.push(`  ${prompt.uid},${prompt.tag},${prompt.prompt},${summarizeTarget(prompt.target)}`);
    }

    if (pendingPrompts.length === 0) {
      lines.push("  <none>");
    }

    lines.push(...(await renderProjectSnapshot(projectPath, project)));
    lines.push("help[2]:");
    lines.push("  Run `rough-cut-axi poll <project-dir>` again to wait for new queued feedback");
    lines.push("  Run `rough-cut-axi apply <project-dir> --ops <ops-json-file>` to apply structured edits");
    lines.push("");
    io.stdout.write(lines.join("\n"));
  } catch (error) {
    io.stdout.write(`error: failed to poll project: ${firstErrorLine(error)}\n`);
    io.stdout.write(
      "help: Check that the project directory contains a readable project.json, then rerun `rough-cut-axi poll <project-dir>`\n",
    );
    process.exitCode = 1;
  }
}

function shouldReportTranscription(project) {
  return ["running", "failed"].includes(project.transcription?.status);
}

async function waitForTranscription(projectFile, timeoutMs) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let watcher;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      watcher?.close();
      callback(value);
    };
    const readLatest = async () => {
      try {
        const project = JSON.parse(await readFile(projectFile, "utf8"));
        if (project.transcription?.status !== "running") {
          finish(resolve, project);
        }
      } catch (error) {
        finish(reject, error);
      }
    };
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(async () => {
            try {
              finish(resolve, JSON.parse(await readFile(projectFile, "utf8")));
            } catch (error) {
              finish(reject, error);
            }
          }, timeoutMs);

    watcher = watch(projectFile, () => {
      readLatest();
    });
  });
}

async function writePollTranscriptionOutput({ projectPath, project, json, io }) {
  const transcription = summarizeTranscription(project.transcription);
  if (json) {
    io.stdout.write(
      `${JSON.stringify(
        {
          project: path.basename(projectPath),
          title: project.title,
          transcription,
          snapshot: await buildProjectSnapshot(projectPath, project),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const lines = [
    `project: ${path.basename(projectPath)}`,
    `title: ${project.title}`,
    `transcription: ${transcription.status}`,
    `progress: ${transcription.completedFootages}/${transcription.totalFootages} footages`,
  ];
  if (transcription.currentFootageId) {
    lines.push(`current_footage: ${transcription.currentFootageId}`);
  }
  if (transcription.error) {
    lines.push(`error: ${transcription.error}`);
  }
  lines.push("help[2]:");
  lines.push("  Run `rough-cut-axi poll <project-dir>` again to check transcription progress");
  lines.push("  Run `rough-cut-axi transcribe <project-dir>` to retry failed transcription");
  lines.push("");
  io.stdout.write(lines.join("\n"));
}

function summarizeTranscription(transcription = {}) {
  return {
    status: transcription.status || "unknown",
    totalFootages: Number(transcription.totalFootages || 0),
    completedFootages: Number(transcription.completedFootages || 0),
    currentFootageId: transcription.currentFootageId || "",
    ...(transcription.error ? { error: transcription.error } : {}),
  };
}

async function writeProjectPresence(projectFile, project, agentPresence) {
  const nextProject = {
    ...project,
    chat: {
      ...project.chat,
      agentPresence,
    },
  };
  await writeFile(projectFile, `${JSON.stringify(nextProject, null, 2)}\n`);
  return nextProject;
}

function findUnknownPollOption(args) {
  const knownFlags = new Set(["--wait", "--timeout-ms", "--agent-reply", "--json"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--timeout-ms" || arg === "--agent-reply") {
      index += 1;
      continue;
    }
    if (arg.startsWith("--") && !knownFlags.has(arg)) {
      return arg;
    }
  }

  return "";
}

function findExtraPollArgument(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--timeout-ms" || arg === "--agent-reply") {
      index += 1;
      continue;
    }
    if (arg === "--wait" || arg === "--json" || arg.startsWith("--")) {
      continue;
    }
    return arg;
  }

  return "";
}

function getPendingPrompts(project) {
  return Array.isArray(project.chat?.pendingPrompts) ? project.chat.pendingPrompts : [];
}

async function waitForQueuedPrompts(projectFile, timeoutMs) {
  return await new Promise((resolve, reject) => {
    let settled = false;
    let watcher;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      watcher?.close();
      callback(value);
    };
    const readLatest = async () => {
      try {
        const project = JSON.parse(await readFile(projectFile, "utf8"));
        if (getPendingPrompts(project).length > 0) {
          finish(resolve, project);
        }
      } catch (error) {
        finish(reject, error);
      }
    };
    const timer =
      timeoutMs === null
        ? null
        : setTimeout(async () => {
            try {
              finish(resolve, JSON.parse(await readFile(projectFile, "utf8")));
            } catch (error) {
              finish(reject, error);
            }
          }, timeoutMs);

    watcher = watch(projectFile, () => {
      readLatest();
    });
  });
}

function firstErrorLine(error) {
  return (
    String(error.stderr || error.message || error)
      .split("\n")
      .find(Boolean) || "unknown error"
  );
}
