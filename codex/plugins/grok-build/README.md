# Grok Build for Codex

Codex plugin that delegates independent reviews, architecture critiques, investigations, and explicitly authorized implementation work to the local Grok Build CLI.

Version: `0.2.1+codex.1`. The `0.2.1` base identifies the upstream Claude Code revision; `+codex.1` identifies this Codex-only package.

## Requirements

- Node.js 18.18 or newer
- Grok Build CLI (`grok`) on `PATH`, or set `GROK_BINARY`
- An authenticated Grok session; verify with `grok models`

## Install

From a clone of this repository, add the Codex marketplace with an absolute path and install the plugin:

```bash
codex plugin marketplace add /absolute/path/to/grok-build-plugin/codex
codex plugin add grok-build@barscn-grok-build
```

Start a new Codex thread after install so the plugin is available.

## Supported operations

The bundled bridge supports:

- Readiness: `check --json`
- Read-only Git review: `review`
- Structured architecture critique: `critique`
- Read-only investigation: `run` (default; no `--write`)
- Explicitly authorized implementation: `run --write`
- Background work, continuation, inspection, and cancellation: `--background`, `runs`, `show`, `stop`, `--resume-last`

Read-only execution is the default. `review`, `critique`, and `run` are read-only. Only an explicit `run --write` removes the sandbox. Reviews and critiques always remain read-only. General installation of this plugin is not write authorization.

## State

Persistent run state is stored under `~/.codex/grok-build/state`, partitioned by canonical workspace path. Set `GROK_CODEX_DATA` to override the data root.

## Exclusions

This Codex package does not include Claude Code commands, agents, hooks, or transcript import. Codex transcript transfer will not be added without a stable documented export interface.

## Source

The runtime is adapted from xAI's Apache-2.0 `grok-build-plugin-cc` at revision `92b76a670713335229644e94add15ab40c80e547`. See `NOTICE` for attribution.
