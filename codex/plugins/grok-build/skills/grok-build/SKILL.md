---
name: grok-build
description: Use when the user asks Codex to consult Grok, obtain an independent code review or architecture critique, delegate a substantial investigation, continue a prior Grok task, or inspect and stop Grok background runs.
---

# Grok Build

Use the bundled bridge to run the local Grok Build CLI. Resolve `<plugin-root>` by taking the directory containing this `SKILL.md` and moving up two directories. Invoke the bridge with an absolute script path and always pass the target workspace explicitly:

```bash
node "<plugin-root>/scripts/grok-bridge.mjs" <command> --cwd "<absolute-workspace>" <arguments>
```

`<plugin-root>` and `<absolute-workspace>` are documentation placeholders: replace both before running a command; never pass either literally. `--cwd` is required for every bridge command, including `check`.

## Readiness

When readiness has not been established in the current conversation, run `check --json` first. Treat `loggedIn: true` as authenticated even when Grok also reports non-fatal settings-fetch warnings. If Node, Grok, or authentication is unavailable, report the exact failed check and stop.

## Choose an operation

- Review local Git changes: `review --wait`. Add `--scope working-tree`, `--scope branch`, or `--base <ref>` only when the requested target requires it.
- Challenge architecture, risk, or design: `critique --wait [focus text]` with the same target options.
- Investigate without modifying files: `run "<task>"`. This read-only mode is the default delegation mode.
- Modify files through Grok: `run --write "<task>"` only when the user explicitly asks Grok to implement, fix, or otherwise change the workspace. General installation of this plugin is not write authorization.
- Continue the latest Grok task for this workspace: `run --resume-last [additional prompt]` and add `--write` only with current explicit Grok write authorization.
- Long work: add `--background`, return the run ID, and use `runs <run-id> --wait`, `show <run-id>`, or `stop <run-id>` as requested.
- Inspect jobs: `runs [run-id] [--all] [--json]`.
- Read a stored result: `show [run-id] [--json]`.
- Stop a tracked job: `stop [run-id] [--json]`.

Reviews and critiques are always read-only. Never weaken their sandbox. For `run`, omit `--write` unless the user explicitly delegated workspace modification to Grok in the current request.

Use only the flags shown for each operation. In particular, `run` does not accept `--wait`; without `--background`, it returns its result synchronously.

## Output contract

Return Grok's substantive output faithfully, identifying it as Grok's result. If Grok fails, times out, is cancelled, or returns incomplete output, report that state and the stored run ID or diagnostic. Do not silently replace a failed Grok delegation with Codex implementation. Codex may analyze Grok's result afterward, but must distinguish its own conclusions from Grok's.
