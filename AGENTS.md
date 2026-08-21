# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- The gate step's `run:` block in `.github/workflows/no-mistakes-required.yml` is mirrored byte-for-byte from `kunchenguid/gh-axi`. Change it upstream first, then re-copy the whole block; this repo keeps its own `on:`, `concurrency`, `permissions`, and author-exemption `if:`. `test/no-mistakes-gate.test.js` extracts and executes that exact block against fixtures (needs `bash` and `jq`).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
