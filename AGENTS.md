# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- `.github/workflows/no-mistakes-required.yml` is a thin caller of the shared `kunchenguid/no-mistakes/.github/actions/require-no-mistakes` composite action, pinned to an immutable commit SHA and never `@main`. Enforcement logic and tests live upstream in the no-mistakes repository; change enforcement there rather than copying it locally, and bump this repository's pin in a deliberate separate pull request. This repository still owns its `on:`, `concurrency`, `permissions`, job name, and author-exemption `if:`.
- The shared action's head binding means a PR whose body no-mistakes did not rewrite for the current head goes red. That is the attestation contract, not a flake: push through `git push no-mistakes` so the body is refreshed.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
