<h1 align="center">rough-cut-axi</h1>
<p align="center">
  <a href="https://github.com/kunchenguid/rough-cut-axi/actions/workflows/ci.yml"
    ><img
      alt="CI"
      src="https://img.shields.io/github/actions/workflow/status/kunchenguid/rough-cut-axi/ci.yml?style=flat-square&label=ci"
  /></a>
  <a href="https://github.com/kunchenguid/rough-cut-axi/actions/workflows/release-please.yml"
    ><img
      alt="Release"
      src="https://img.shields.io/github/actions/workflow/status/kunchenguid/rough-cut-axi/release-please.yml?style=flat-square&label=release"
  /></a>
  <a
    href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
    ><img
      alt="Platform"
      src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-blue?style=flat-square"
  /></a>
  <a href="https://x.com/kunchenguid"
    ><img
      alt="X"
      src="https://img.shields.io/badge/X-@kunchenguid-black?style=flat-square"
  /></a>
  <a href="https://discord.gg/Wsy2NpnZDu"
    ><img
      alt="Discord"
      src="https://img.shields.io/discord/1439901831038763092?style=flat-square&label=discord"
  /></a>
</p>

<h3 align="center">Cut by transcript, collaborate in the browser, render without leaving your shell.</h3>

Rough-cut editing should not force you to choose between a heavyweight NLE and a pile of brittle scripts.
You want transcript-aware cuts, human review, and agent help that can operate on real project state instead of guessing from screenshots.

`rough-cut-axi` is a local-first, transcript-based video editor for agent-assisted rough cuts.
It opens footage in a browser editor, keeps footage files untouched, exposes compact project snapshots to agents, and renders deterministic cuts with `ffmpeg`.

- **Manuscript-first cuts** - Read the transcript as prose, then mark passages to keep or skip.
- **Human-agent loop** - Queue browser feedback, long-poll it from the CLI, and apply structured edits only when they are safe or approved.
- **Local render contract** - Store projects under `~/.rough-cut-axi`, export `timeline.json`, and render preview or final MP4 files from kept passages with `ffmpeg`.

## Quick Start

```sh
$ rough-cut-axi auth elevenlabs --api-key "$ELEVENLABS_API_KEY"
auth: elevenlabs
status: stored

$ rough-cut-axi open ./footage-a.mp4 ./footage-b.mp4
project: 20260515-153012-footage
footages: 2 footages
session:
  status: open
  url: http://127.0.0.1:4388/?project=...

$ rough-cut-axi transcribe ~/.rough-cut-axi/projects/20260515-153012-footage
transcripts: 2 written
transcript_index: ~/.rough-cut-axi/projects/20260515-153012-footage/transcript_index.md
```

## Install

`rough-cut-axi` currently installs from this repository.
You need Node.js 20 or newer, pnpm, `ffmpeg`, `ffprobe`, and an ElevenLabs API key for transcription.

**From repository**

```sh
git clone https://github.com/kunchenguid/rough-cut-axi.git
cd rough-cut-axi
corepack enable
pnpm install
pnpm link --global
rough-cut-axi --help
```

## How It Works

```
┌────────────────────┐
│ Footage files      │
└─────────┬──────────┘
          ▼
┌────────────────────┐
│ open creates local │
│ project directory  │
└─────────┬──────────┘
          ▼
┌────────────────────┐
│ browser editor     │
│ manuscript + video │
└──────┬────────┬────┘
       │        │
       ▼        ▼
┌───────────┐  ┌────────────────┐
│ passages  │  │ queued prompts │
└─────┬─────┘  └───────┬────────┘
      ▼                ▼
┌──────────────┐  ┌───────────────┐
│ project.json │  │ agent poll    │
│ timeline.json│  │ snapshot/apply│
└──────┬───────┘  └──────┬────────┘
       └────────┬────────┘
                ▼
        ┌───────────────┐
        │ ffmpeg render │
        │ preview/final │
        └───────────────┘
```

- **Project state is plain files** - `project.json` is the editor truth and `timeline.json` is the render contract.
- **Footage stays put** - Projects reference original files by absolute path instead of copying or mutating them.
- **Agent commands are bounded** - Agents read snapshots, wait for queued prompts, and apply JSON edit operations through validation.
- **Rendering is explicit** - Preview and final outputs are built from timeline segments, short audio fades, and duration verification.

## CLI Reference

| Command                                  | Description                                                                     |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `rough-cut-axi`                          | Show local home state, active sessions, and known projects.                     |
| `rough-cut-axi open <video-file...>`     | Create a project from one or more footages and open the browser editor.         |
| `rough-cut-axi open <project-dir>`       | Reopen an existing project directory.                                           |
| `rough-cut-axi auth elevenlabs`          | Store an ElevenLabs API key in the local home directory.                        |
| `rough-cut-axi transcribe <project-dir>` | Transcribe footages and write passages into `project.json`.                     |
| `rough-cut-axi poll <project-dir>`       | Wait for queued browser feedback and return an agent-friendly project snapshot. |
| `rough-cut-axi snapshot <project-dir>`   | Print passages, nearby transcript, and render status.                           |
| `rough-cut-axi apply <project-dir>`      | Apply structured edit operations from a JSON file.                              |
| `rough-cut-axi render <project-dir>`     | Render `renders/preview.mp4` or `renders/final.mp4`.                            |
| `rough-cut-axi end <project-dir>`        | Remove the active editor session for a project.                                 |
| `rough-cut-axi server`                   | Run the local browser editor server.                                            |

### Flags

| Command           | Flag                    | Description                                                         |
| ----------------- | ----------------------- | ------------------------------------------------------------------- |
| `rough-cut-axi`   | `--json`                | Emit raw structured home state.                                     |
| `open`            | `--json`                | Emit project metadata without launching the browser session output. |
| `auth elevenlabs` | `--api-key <key>`       | Store the ElevenLabs API key.                                       |
| `auth elevenlabs` | `--json`                | Emit raw structured auth status.                                    |
| `transcribe`      | `--json`                | Emit written and cached transcript metadata.                        |
| `poll`            | `--wait`                | Compatibility flag because polling waits by default.                |
| `poll`            | `--timeout-ms <ms>`     | Stop waiting after a bounded time for tests or debugging.           |
| `poll`            | `--agent-reply <text>`  | Record an agent reply and clear queued prompts.                     |
| `poll`            | `--json`                | Emit pending prompts and snapshot JSON.                             |
| `snapshot`        | `--range <start:end>`   | Filter timeline context by output time.                             |
| `snapshot`        | `--json`                | Emit the project snapshot as JSON.                                  |
| `apply`           | `--ops <ops-json-file>` | Read a JSON array of edit operations.                               |
| `apply`           | `--approved`            | Allow broad edit plans with more than three operations.             |
| `apply`           | `--json`                | Emit apply results as JSON.                                         |
| `render`          | `--preview`             | Render `renders/preview.mp4`.                                       |
| `render`          | `--final`               | Render `renders/final.mp4`.                                         |
| `render`          | `--json`                | Emit render metadata as JSON.                                       |
| `end`             | `--json`                | Emit session end status as JSON.                                    |
| `server`          | `--port <port>`         | Run the local editor server on a specific port.                     |

## Configuration

Generated state lives under `~/.rough-cut-axi` by default.
Use `ROUGH_CUT_AXI_HOME` to move all auth, project, and session files somewhere else.

```sh
# Local state root.
export ROUGH_CUT_AXI_HOME="$HOME/.rough-cut-axi"

# Optional direct auth override.
export ELEVENLABS_API_KEY="sk_..."

# Browser editor server port.
export ROUGH_CUT_AXI_PORT="4388"

# Custom ffmpeg binaries.
export ROUGH_CUT_AXI_FFMPEG_BIN="/opt/homebrew/bin/ffmpeg"
export ROUGH_CUT_AXI_FFPROBE_BIN="/opt/homebrew/bin/ffprobe"

# Test and fixture hooks.
export ROUGH_CUT_AXI_NO_BROWSER_OPEN="1"
export ROUGH_CUT_AXI_ELEVENLABS_FIXTURE_DIR="./test/fixtures/transcripts"
```

`ELEVENLABS_API_KEY` takes precedence over `~/.rough-cut-axi/auth.json`.
Other `ROUGH_CUT_AXI_*` environment variables override built-in defaults for the current process.

Project directories use this layout:

```text
~/.rough-cut-axi/projects/<project-id>/
├── project.json
├── project.md
├── timeline.json
├── transcript_index.md
├── transcripts/
├── renders/
│   ├── preview.mp4
│   └── final.mp4
├── segments/
└── verify/
```

## Development

```sh
pnpm install # Install dependencies
pnpm run check # Run formatting and lint checks
pnpm test # Run Node unit tests
pnpm run test:e2e # Run Playwright end-to-end tests
pnpm run format # Format the repository
```
