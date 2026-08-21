# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- The gate step's `run:` block in `.github/workflows/no-mistakes-required.yml` mirrors `kunchenguid/gh-axi`, plus one deliberate local addition: the attestation's `head_sha` must equal the PR's current head (`PR_HEAD_SHA`). Change the shared logic upstream first, then re-copy the block and re-apply the head binding; this repo keeps its own `on:`, `concurrency`, `permissions`, and author-exemption `if:`.
- Head binding means a PR whose body no-mistakes did not rewrite for the current head goes red. That is the attestation contract, not a flake: push through `git push no-mistakes` so the body is refreshed.
- `test/no-mistakes-gate.test.js` extracts and executes that exact block against fixtures (needs `bash` and `jq`); `test/helpers/no-mistakes-gate.js` holds the extractor.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
