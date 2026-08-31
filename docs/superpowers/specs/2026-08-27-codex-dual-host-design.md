# Grok Build Dual-Host Plugin Design

## Purpose

Extend this repository with a first-class Codex plugin while preserving the existing Claude Code plugin. Both host packages delegate to the locally installed Grok Build CLI, but each package must follow its host's discovery, state, lifecycle, and permission conventions.

The Codex package begins at version `0.2.1+codex.1`. The `0.2.1` base identifies the upstream Claude Code revision from which the runtime was adapted; the `+codex.N` metadata identifies Codex-only revisions.

## Goals

- Keep the existing Claude Code marketplace and plugin behavior intact.
- Add a self-contained Codex marketplace that can be installed from this repository.
- Port the proven local Codex adaptation into version-controlled source.
- Preserve read-only defaults and require explicit current-user authorization before Grok receives write access.
- Keep host-specific lifecycle and state behavior isolated.
- Provide regression tests for both hosts and document installation and maintenance.

## Non-goals

- Replacing or restructuring the existing Claude Code plugin.
- Sharing runtime files through symlinks or imports outside an installed plugin root.
- Adding Codex transcript import without a stable documented Codex transcript export interface.
- Installing Grok Build, authenticating users, or storing credentials.
- Publishing the marketplace or pushing repository changes as part of this implementation.
- Adding MCP servers, apps, hooks, or background services to the Codex package.

## Repository layout

```text
grok-build-plugin/
├── .claude-plugin/marketplace.json
├── plugins/grok-build/                 # Existing Claude Code plugin
├── codex/
│   ├── .agents/plugins/marketplace.json
│   └── plugins/grok-build/
│       ├── .codex-plugin/plugin.json
│       ├── skills/grok-build/SKILL.md
│       ├── scripts/
│       ├── prompts/
│       ├── schemas/
│       ├── LICENSE
│       ├── NOTICE
│       ├── README.md
│       └── package.json
├── scripts/
├── tests/
└── README.md
```

The `codex/` directory is an independent marketplace root. Keeping the Codex package below that root allows it to retain the plugin identifier `grok-build` without colliding with the existing Claude Code package at `plugins/grok-build`.

The Codex marketplace identifier is `barscn-grok-build`. Its entry uses local source path `./plugins/grok-build`, installation policy `AVAILABLE`, authentication policy `ON_INSTALL`, and category `Productivity`.

## Codex manifest and discovery

`codex/plugins/grok-build/.codex-plugin/plugin.json` must:

- use plugin name `grok-build`;
- use version `0.2.1+codex.1`;
- identify `barscn` as the adaptation publisher;
- retain the Apache-2.0 license and link to this repository;
- declare only the shipped skill path;
- omit unsupported or absent `hooks`, `apps`, and `mcpServers` fields;
- describe read and explicitly authorized write capabilities;
- provide no more than three concise starter prompts.

Codex discovers one user-facing skill at `skills/grok-build/SKILL.md`. Claude-only internal skills, commands, agents, hooks, and transcript-transfer files are not copied into the Codex package.

## User-facing Codex workflow

The Codex skill is the orchestration contract. It instructs Codex to:

1. Resolve the bundled bridge from the installed plugin root.
2. Pass an explicit absolute workspace through `--cwd` on every command.
3. Run `check --json` once per conversation before the first Grok task.
4. Use `review` or `critique` for read-only analysis.
5. Use `run` without `--write` for read-only investigation.
6. Use `run --write` only when the current user request explicitly authorizes Grok to change workspace files.
7. Use background, status, show, resume, and stop operations through the bridge.
8. Report Grok failures faithfully rather than silently substituting a Codex implementation.

The skill exposes only flags the bridge supports. Review and critique always remain read-only.

## Runtime behavior

The Codex runtime is adapted from the existing Claude Code bridge and remains Node.js standard-library-only.

Shared behavior includes:

- Grok binary discovery through `PATH` or `GROK_BINARY`;
- readiness and soft-auth probing through `grok models`;
- Git target collection for working-tree and branch review;
- structured critique output;
- foreground and plugin-owned background delegation;
- stored run inspection, continuation, and cancellation;
- process-tree termination and terminal-state conflict protection;
- literal Git argument handling on Windows;
- `--model` and `--effort` forwarding.

Codex-specific behavior includes:

- persistent state under `~/.codex/grok-build/state`;
- `GROK_CODEX_DATA` as the optional data-root override;
- workspace-scoped job discovery and continuation, because Codex supplies no Claude session hook identifier;
- progress messages prefixed with `[grok-codex]`;
- readiness output describing plugin-owned Codex runs;
- successful auth detail that retains non-fatal `grok models` stderr diagnostics;
- no `import` command or Claude transcript parsing;
- no lifecycle hook or automatic session cleanup.

## Permission model

The bridge is a policy enforcement layer in addition to the skill instructions.

- `review` and `critique` invoke Grok with `--always-approve --sandbox read-only`.
- `run` without `--write` invokes Grok with `--always-approve --sandbox read-only`.
- `run --write` invokes Grok with `--always-approve` and without the read-only sandbox.
- The Codex skill may add `--write` only when the current user request explicitly authorizes workspace modification.
- Reviews and critiques never accept write access.

Headless runs use auto-approval because no user is present to approve individual Grok tool calls. For read-only operations, the sandbox—not interactive approval—is the safety boundary.

## State and concurrency

Run state is partitioned by canonical workspace path using the existing slug-and-hash scheme. Each workspace stores its state and job logs below its resolved state directory.

Unlike the Claude package, Codex does not filter jobs by a host session identifier. Operations therefore behave as follows:

- `runs` lists jobs for the current workspace;
- `show` selects an explicit run or the latest finished workspace run;
- `--resume-last` selects the latest resumable workspace task;
- `stop` requires a run ID when multiple workspace jobs are active;
- terminal-state compare-and-set behavior prevents cancellation/completion races.

## Source synchronization

The installed Codex plugin must be self-contained, so runtime imports cannot escape `codex/plugins/grok-build` and symlinks are not used.

Tests maintain the host boundary:

- files that are intentionally identical between packages are compared byte-for-byte;
- Codex-specific runtime files are covered by behavior tests rather than copied blindly;
- the test suite fails if Claude-only artifacts appear in the Codex package;
- the existing Claude tests remain unchanged unless a shared test helper requires a compatible extension.

The initial identical-file set is:

- `prompts/critique.md`;
- `schemas/review-output.schema.json`;
- `scripts/lib/args.mjs`;
- `scripts/lib/fs.mjs`;
- `scripts/lib/git.mjs`;
- `scripts/lib/process.mjs`;
- `scripts/lib/prompts.mjs`;
- `scripts/lib/render.mjs`;
- `scripts/lib/workspace.mjs`.

The bridge, Grok adapter, job control, state, and tracked-job modules are deliberately host-specific and are not required to be byte-identical.

## Documentation and installation

The root README describes both hosts without removing the existing Claude Code instructions. The Codex section uses:

```bash
codex plugin marketplace add /absolute/path/to/grok-build-plugin/codex
codex plugin add grok-build@barscn-grok-build
```

Users must start a new Codex thread after installation. Prerequisites remain Node.js 18.18 or newer, a local `grok` executable on `PATH` (or `GROK_BINARY`), and an authenticated Grok session verified with `grok models`.

The Codex package README documents commands, state location, permission boundaries, exclusions, upstream attribution, and the versioning scheme. `NOTICE` records the exact upstream revision used for the adaptation.

## Testing strategy

Implementation follows red-green-refactor for behavior changes.

The existing Claude suite remains the baseline and must continue to pass. New Codex tests cover:

- marketplace and plugin manifest schema, names, version, and source paths;
- absence of Claude-only commands, agents, hooks, transcript import, and session environment names;
- valid Codex skill frontmatter, discovery, and realistic forward behavior under read-only and explicitly authorized write requests;
- Codex readiness, review, critique, run, runs, show, resume, and stop behavior through the fake Grok fixture;
- read-only and write-mode Grok arguments;
- `GROK_CODEX_DATA` and default state-root resolution;
- workspace-scoped job selection and ambiguity handling;
- retained auth stderr diagnostics;
- byte identity of the explicitly shared file set;
- JavaScript syntax and plugin-manifest validation;
- version consistency, with installation documentation reviewed as human-facing prose rather than regex-tested.

Verification gates are:

```bash
npm test
python3 /Users/baroman/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py codex/plugins/grok-build
python3 /Users/baroman/.codex/skills/.system/skill-creator/scripts/quick_validate.py codex/plugins/grok-build/skills/grok-build
node scripts/bump-version.mjs --check
git diff --check
```

If the validator's Python environment lacks PyYAML, it may be run with an already-installed PyYAML environment; the implementation must not add a Python dependency to this repository solely for local validation.

## Acceptance criteria

- The existing Claude Code plugin and all of its tests still work.
- `codex/` is a valid independently installable Codex marketplace.
- The Codex package version is `0.2.1+codex.1` everywhere it is represented.
- The Codex skill and runtime enforce the stated read/write boundary.
- Every supported Codex operation is documented and tested.
- Claude-only artifacts and transcript import are absent from the Codex package.
- Shared-file drift is detected by tests.
- The full verification gates pass with no repository diff errors.
- No plugin is installed, no credentials are handled, and no remote changes are pushed during implementation.
