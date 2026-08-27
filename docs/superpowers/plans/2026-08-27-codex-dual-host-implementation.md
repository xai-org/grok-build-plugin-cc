# Grok Build Dual-Host Codex Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This repository's orchestration policy additionally requires execution through the Grok Build bridge and independent Codex review.

**Goal:** Add a self-contained Codex marketplace and plugin beside the existing Claude Code plugin without regressing the Claude package.

**Architecture:** Preserve `.claude-plugin/` and `plugins/grok-build/` as the Claude Code package. Add `codex/` as a second marketplace root containing a host-specific `grok-build` package; copy only explicitly shared runtime files and implement Codex-specific state, lifecycle, bridge, and skill behavior inside that package.

**Tech Stack:** Node.js 18.18+ standard library, Node test runner, JSON plugin manifests, Markdown skills and documentation, Grok Build CLI bridge.

**Spec:** `docs/superpowers/specs/2026-08-27-codex-dual-host-design.md`

## Global Constraints

- Keep the existing Claude Code plugin behavior and all 64 baseline tests passing.
- Use Codex plugin version `0.2.1+codex.1`; the Claude/root release remains `0.2.1`.
- Use Codex marketplace identifier `barscn-grok-build` and plugin identifier `grok-build`.
- Keep the Codex plugin self-contained below `codex/plugins/grok-build`; do not use symlinks or imports outside its root.
- Keep runtime dependencies limited to the Node.js standard library.
- Default `review`, `critique`, and `run` to read-only; only explicit `run --write` removes the read-only sandbox.
- Do not add Claude hooks, agents, commands, transcript import, or Claude session environment variables to the Codex package.
- Do not install plugins, authenticate accounts, publish releases, or push branches.
- Use red-green-refactor for every behavior change and run the named focused test before the full suite.

---

### Task 1: Codex marketplace and package contract

**Files:**
- Create: `tests/codex-package.test.mjs`
- Create: `codex/.agents/plugins/marketplace.json`
- Create: `codex/plugins/grok-build/.codex-plugin/plugin.json`
- Create: `codex/plugins/grok-build/skills/grok-build/SKILL.md`
- Create: `codex/plugins/grok-build/package.json`
- Create: `codex/plugins/grok-build/LICENSE`
- Create: `codex/plugins/grok-build/NOTICE`
- Create: `codex/plugins/grok-build/README.md`
- Copy unchanged: `codex/plugins/grok-build/prompts/critique.md`
- Copy unchanged: `codex/plugins/grok-build/schemas/review-output.schema.json`
- Copy unchanged: `codex/plugins/grok-build/scripts/lib/{args,fs,git,process,prompts,render,workspace}.mjs`

**Interfaces:**
- Consumes: the approved marketplace and manifest contract from the design spec; shared source files under `plugins/grok-build`.
- Produces: installable marketplace root `codex/`, plugin root `codex/plugins/grok-build`, and the user-facing `grok-build` skill used by every later task.

- [ ] **Step 1: Write the failing package-contract test**

Create `tests/codex-package.test.mjs` with helpers and assertions equivalent to:

```js
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_ROOT = path.join(ROOT, "codex");
const CODEX_PLUGIN = path.join(CODEX_ROOT, "plugins", "grok-build");
const CLAUDE_PLUGIN = path.join(ROOT, "plugins", "grok-build");

function read(relativePath) {
  return fs.readFileSync(path.join(CODEX_PLUGIN, relativePath), "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

test("Codex marketplace points to the self-contained grok-build plugin", () => {
  const marketplace = readJson(path.join(CODEX_ROOT, ".agents", "plugins", "marketplace.json"));
  assert.equal(marketplace.name, "barscn-grok-build");
  assert.equal(marketplace.interface.displayName, "Grok Build for Codex");
  assert.deepEqual(marketplace.plugins, [{
    name: "grok-build",
    source: { source: "local", path: "./plugins/grok-build" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity"
  }]);
});

test("Codex manifest uses the approved identity and version", () => {
  const manifest = readJson(path.join(CODEX_PLUGIN, ".codex-plugin", "plugin.json"));
  assert.equal(manifest.name, "grok-build");
  assert.equal(manifest.version, "0.2.1+codex.1");
  assert.equal(manifest.author.name, "barscn");
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(manifest.repository, "https://github.com/barscn/grok-build-plugin");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(Object.hasOwn(manifest, "hooks"), false);
  assert.equal(Object.hasOwn(manifest, "apps"), false);
  assert.equal(Object.hasOwn(manifest, "mcpServers"), false);
  assert.ok(manifest.interface.defaultPrompt.length <= 3);
});

test("Codex package excludes Claude-only surfaces", () => {
  for (const relativePath of ["commands", "agents", "hooks", "scripts/session-lifecycle-hook.mjs", "scripts/lib/claude-session-transfer.mjs"]) {
    assert.equal(fs.existsSync(path.join(CODEX_PLUGIN, relativePath)), false, relativePath);
  }
  const skill = read("skills/grok-build/SKILL.md");
  assert.match(skill, /check --json/);
  assert.match(skill, /--cwd/);
  assert.match(skill, /run --write/);
  assert.match(skill, /explicitly asks Grok to implement/i);
  assert.match(skill, /Reviews and critiques are always read-only/i);
  assert.match(skill, /Do not silently replace/i);
});
```

Add a byte-identity test over this exact list:

```js
const SHARED_FILES = [
  "prompts/critique.md",
  "schemas/review-output.schema.json",
  "scripts/lib/args.mjs",
  "scripts/lib/fs.mjs",
  "scripts/lib/git.mjs",
  "scripts/lib/process.mjs",
  "scripts/lib/prompts.mjs",
  "scripts/lib/render.mjs",
  "scripts/lib/workspace.mjs"
];

test("explicitly shared files match the Claude package byte-for-byte", () => {
  for (const relativePath of SHARED_FILES) {
    assert.deepEqual(
      fs.readFileSync(path.join(CODEX_PLUGIN, relativePath)),
      fs.readFileSync(path.join(CLAUDE_PLUGIN, relativePath)),
      relativePath
    );
  }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/codex-package.test.mjs`

Expected: FAIL because `codex/.agents/plugins/marketplace.json` and `codex/plugins/grok-build` do not exist.

- [ ] **Step 3: Add the minimal marketplace and manifest**

Create `codex/.agents/plugins/marketplace.json` with exactly:

```json
{
  "name": "barscn-grok-build",
  "interface": { "displayName": "Grok Build for Codex" },
  "plugins": [
    {
      "name": "grok-build",
      "source": { "source": "local", "path": "./plugins/grok-build" },
      "policy": { "installation": "AVAILABLE", "authentication": "ON_INSTALL" },
      "category": "Productivity"
    }
  ]
}
```

Create the Codex manifest with name `grok-build`, version `0.2.1+codex.1`, author/developer `barscn`, repository `https://github.com/barscn/grok-build-plugin`, license `Apache-2.0`, skill path `./skills/`, Read/Write capabilities, and at most three starter prompts. Do not add hooks, apps, or MCP fields.

- [ ] **Step 4: Add the skill, package documentation, attribution, and shared files**

Port the proven Codex skill contract from `/Users/baroman/plugins/grok-build/skills/grok-build/SKILL.md`, changing no permission semantics. Copy `LICENSE` from the repository root. Write `NOTICE` to retain the xAI copyright and cite upstream revision `92b76a670713335229644e94add15ab40c80e547` plus the `barscn` Codex adaptation. Add a package README covering requirements, supported operations, state, exclusions, and versioning. Copy every `SHARED_FILES` entry from `plugins/grok-build` without editing it.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `node --test tests/codex-package.test.mjs`

Expected: PASS for marketplace, manifest, skill, exclusions, and byte identity.

- [ ] **Step 6: Commit the package contract**

```bash
git add codex tests/codex-package.test.mjs
git commit -m "feat: add Codex marketplace package"
```

---

### Task 2: Codex state and workspace job semantics

**Files:**
- Create: `tests/codex-state.test.mjs`
- Create: `tests/codex-job-control.test.mjs`
- Create: `codex/plugins/grok-build/scripts/lib/state.mjs`
- Create: `codex/plugins/grok-build/scripts/lib/tracked-jobs.mjs`
- Create: `codex/plugins/grok-build/scripts/lib/job-control.mjs`

**Interfaces:**
- Consumes: shared `workspace.mjs`; existing state record schema and job lifecycle behavior.
- Produces: `resolveStateDir(cwd, env)`, workspace-wide `buildStatusSnapshot`, `resolveResultJob`, `resolveCancelableJob`, and session-independent job records for the Codex bridge.

- [ ] **Step 1: Write failing state-root tests**

Create `tests/codex-state.test.mjs` importing the Codex state module and asserting:

```js
test("Codex state defaults below ~/.codex/grok-build/state", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace, {});
  assert.equal(stateDir.startsWith(path.join(os.homedir(), ".codex", "grok-build", "state")), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
});

test("GROK_CODEX_DATA overrides the Codex data root", () => {
  const workspace = makeTempDir();
  const dataRoot = makeTempDir();
  const stateDir = resolveStateDir(workspace, { GROK_CODEX_DATA: dataRoot });
  assert.equal(stateDir.startsWith(path.join(dataRoot, "state")), true);
});
```

Also port the existing pruning, corrupt-state quarantine, missing-state, and terminal compare-and-set tests to import the Codex state module and pass a temporary `GROK_CODEX_DATA` environment so tests never write to the real home directory.

- [ ] **Step 2: Write failing workspace-job tests**

Create `tests/codex-job-control.test.mjs` using temporary Codex state. Assert that job records omit `sessionId`, `buildStatusSnapshot` includes jobs from the whole workspace, `resolveResultJob` selects the latest finished job, and `resolveCancelableJob` throws `/Multiple Grok Build runs are active/` when two jobs are active without a reference.

Include this direct contract assertion:

```js
const record = createJobRecord({ id: "run-1", workspaceRoot, status: "queued" });
assert.equal(Object.hasOwn(record, "sessionId"), false);
```

- [ ] **Step 3: Run both focused tests and verify RED**

Run: `node --test tests/codex-state.test.mjs tests/codex-job-control.test.mjs`

Expected: FAIL because the Codex state and job-control modules do not exist.

- [ ] **Step 4: Implement the Codex state modules minimally**

Start from the corresponding Claude modules, then make only these host deltas:

```js
const PLUGIN_DATA_ENV = "GROK_CODEX_DATA";
const DEFAULT_STATE_ROOT_DIR = path.join(os.homedir(), ".codex", "grok-build", "state");

export function resolveStateDir(cwd, env = process.env) {
  // Preserve canonical workspace slug/hash logic.
  const configuredDataDir = env[PLUGIN_DATA_ENV];
  const stateRoot = configuredDataDir
    ? path.join(configuredDataDir, "state")
    : DEFAULT_STATE_ROOT_DIR;
  // Return stateRoot plus the existing workspace slug/hash.
}
```

Remove Claude session IDs from `tracked-jobs.mjs`. Prefix progress with `[grok-codex]`. In `job-control.mjs`, remove session filtering and select/resolve jobs across the current workspace only. Preserve process-tree termination, job-file ordering, pruning, and terminal compare-and-set logic.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test tests/codex-state.test.mjs tests/codex-job-control.test.mjs`

Expected: PASS with all state written below temporary test roots.

- [ ] **Step 6: Run related Claude regression tests**

Run: `node --test tests/state.test.mjs tests/job-terminal.test.mjs`

Expected: PASS; Claude state behavior remains unchanged.

- [ ] **Step 7: Commit the state adaptation**

```bash
git add codex/plugins/grok-build/scripts/lib/state.mjs codex/plugins/grok-build/scripts/lib/tracked-jobs.mjs codex/plugins/grok-build/scripts/lib/job-control.mjs tests/codex-state.test.mjs tests/codex-job-control.test.mjs
git commit -m "feat: add Codex workspace run state"
```

---

### Task 3: Codex Grok adapter and bridge operations

**Files:**
- Create: `tests/codex-runtime.test.mjs`
- Create: `tests/codex-permissions.test.mjs`
- Modify: `tests/fake-grok-fixture.mjs`
- Create: `codex/plugins/grok-build/scripts/lib/grok.mjs`
- Create: `codex/plugins/grok-build/scripts/grok-bridge.mjs`

**Interfaces:**
- Consumes: Task 1 package contract, Task 2 state/job modules, shared Git and rendering modules, `buildEnv` and `installFakeGrok` fixtures.
- Produces: CLI commands `check`, `review`, `critique`, `run`, `run-resume-candidate`, `runs`, `show`, `stop`, plus internal worker commands; deliberately does not produce `import`.

- [ ] **Step 1: Write failing permission tests against the Codex bridge**

Create `tests/codex-permissions.test.mjs` by adapting the three existing permission tests to:

```js
const SCRIPT = path.join(ROOT, "codex", "plugins", "grok-build", "scripts", "grok-bridge.mjs");

function pluginDataEnv(pluginDataDir, binDir, extra = {}) {
  return buildEnv(binDir, { GROK_CODEX_DATA: pluginDataDir, ...extra });
}
```

Retain exact assertions:

- review contains `--always-approve --sandbox read-only`;
- read-only run contains `--always-approve --sandbox read-only`;
- `run --write` contains `--always-approve` and no `--sandbox`.

- [ ] **Step 2: Write failing end-to-end runtime tests**

Create `tests/codex-runtime.test.mjs` with temporary repositories and fake Grok. Cover:

```js
test("Codex check reports ready and plugin-owned runtime", () => {
  // Run check --json with GROK_CODEX_DATA and fake Grok.
  assert.equal(payload.ready, true);
  assert.equal(payload.sessionRuntime.mode, "plugin-owned");
  assert.match(payload.sessionRuntime.detail, /Codex plugin/);
});

test("Codex bridge rejects Claude transcript import", () => {
  const result = run("node", [SCRIPT, "import"], { cwd: ROOT, env });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Unknown command: import/);
});
```

Add behavior tests for:

- `review` output and `--model`/`--effort` forwarding;
- structured `critique --json` output;
- foreground `run` storing a completed task;
- `runs --json` and `show --json` surfacing that task;
- `run-resume-candidate --json` returning the latest workspace task and `threadId`;
- `run --resume-last` passing the stored thread ID to fake Grok;
- `stop` cancelling one tracked sleeper and rejecting an ambiguous no-ID stop with two active jobs;
- successful `grok models` status retaining a non-fatal stderr line.

Extend `installFakeGrok` only as needed to emit a deterministic warning on successful `models` and to log resume arguments. Do not change existing fixture defaults, so Claude tests retain their current outputs.

- [ ] **Step 3: Run focused tests and verify RED**

Run: `node --test tests/codex-permissions.test.mjs tests/codex-runtime.test.mjs`

Expected: FAIL because the Codex Grok adapter and bridge do not exist.

- [ ] **Step 4: Implement the Codex Grok adapter**

Start from `plugins/grok-build/scripts/lib/grok.mjs`. Preserve binary discovery, headless argument construction, progress callbacks, structured parsing, model/effort forwarding, and process reporting. Remove `runImport`. On successful auth, retain both the success summary and trimmed stderr:

```js
const stdout = (result.stdout || "").trim();
const stderr = (result.stderr || "").trim();
const detail = [firstLine(stdout) || "grok models succeeded", stderr]
  .filter(Boolean)
  .join("\n");
```

- [ ] **Step 5: Implement the Codex bridge**

Start from the Claude bridge and remove all Claude transcript-transfer and session-ID paths. Keep `--cwd` required. Use all Task 2 job operations workspace-wide. Ensure the command switch has no `import` case. Preserve:

```js
// review / critique
alwaysApprove: true,
sandbox: "read-only"

// task
alwaysApprove: true,
sandbox: write ? undefined : "read-only"
```

Keep foreground/background run tracking, worker commands, status/show/stop, structured rendering, and resume behavior. Change user-facing runtime text and progress prefixes from Claude to Codex.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `node --test tests/codex-permissions.test.mjs tests/codex-runtime.test.mjs`

Expected: PASS for all supported Codex operations and permission modes.

- [ ] **Step 7: Run all runtime regression tests**

Run: `node --test tests/grok-cli.test.mjs tests/grok-bridge-permissions.test.mjs tests/runtime.test.mjs tests/codex-permissions.test.mjs tests/codex-runtime.test.mjs`

Expected: PASS for both hosts; existing Claude import still works and Codex import remains absent.

- [ ] **Step 8: Commit the Codex runtime**

```bash
git add codex/plugins/grok-build/scripts tests/codex-permissions.test.mjs tests/codex-runtime.test.mjs tests/fake-grok-fixture.mjs
git commit -m "feat: port Grok bridge runtime to Codex"
```

---

### Task 4: Dual-version release checks and documentation

**Files:**
- Modify: `tests/bump-version.test.mjs`
- Modify: `scripts/bump-version.mjs`
- Modify: `README.md`
- Modify: `codex/plugins/grok-build/README.md`
- Test: `tests/codex-package.test.mjs`

**Interfaces:**
- Consumes: Claude release version from root `package.json`; Codex package metadata from Task 1.
- Produces: `codexVersionFor(baseVersion, revision = 1)` and repository documentation for both installation paths.

- [ ] **Step 1: Write failing dual-version tests**

Extend the version fixture with:

```js
writeJson(path.join(root, "codex", "plugins", "grok-build", "package.json"), {
  name: "@barscn/grok-build-codex",
  version: "0.1.0+codex.1"
});
writeJson(path.join(root, "codex", "plugins", "grok-build", ".codex-plugin", "plugin.json"), {
  name: "grok-build",
  version: "0.1.0+codex.1"
});
```

Update `bump-version updates every release manifest` to expect `1.2.3` in Claude targets and `1.2.3+codex.1` in both Codex targets. Add a stale Codex assertion to check mode. Change the repository check to:

```js
test("repo host manifests are in sync at 0.2.1 and 0.2.1+codex.1", () => {
  const result = run("node", [SCRIPT, "--check", "0.2.1"], { cwd: ROOT });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0\.2\.1\+codex\.1/);
});
```

Add README assertions to `tests/codex-package.test.mjs` for the exact install commands and the current Claude `Version: 0.2.1` line.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test tests/bump-version.test.mjs tests/codex-package.test.mjs`

Expected: FAIL because the version tool ignores Codex targets and the root README is Claude-only/stale at `0.2.0`.

- [ ] **Step 3: Implement derived Codex version checks**

Add:

```js
const CODEX_REVISION = 1;

function codexVersionFor(baseVersion, revision = CODEX_REVISION) {
  const withoutBuild = baseVersion.split("+", 1)[0];
  return `${withoutBuild}+codex.${revision}`;
}
```

Keep existing `TARGETS` for Claude. Add `CODEX_TARGETS` for:

- `codex/plugins/grok-build/package.json` `version`;
- `codex/plugins/grok-build/.codex-plugin/plugin.json` `version`.

In update mode, write the base version to Claude targets and `codexVersionFor(baseVersion)` to Codex targets. In check mode, report mismatches from both groups and print both expected versions. Export no new public API; test through the CLI.

- [ ] **Step 4: Update root and Codex documentation**

Retitle the root README to a host-neutral Grok Build bridge. Preserve the complete Claude Code install and command reference. Add a Codex section containing exactly:

```bash
codex plugin marketplace add /absolute/path/to/grok-build-plugin/codex
codex plugin add grok-build@barscn-grok-build
```

Explain that a new Codex thread is required, list supported Codex operations, state path and environment override, read/write policy, and Claude-only exclusions. Correct the Claude release line to `Version: 0.2.1` and identify Codex as `Version: 0.2.1+codex.1`.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `node --test tests/bump-version.test.mjs tests/codex-package.test.mjs`

Expected: PASS with both host versions and install docs consistent.

- [ ] **Step 6: Commit versioning and documentation**

```bash
git add scripts/bump-version.mjs tests/bump-version.test.mjs tests/codex-package.test.mjs README.md codex/plugins/grok-build/README.md
git commit -m "docs: document dual-host plugin releases"
```

---

### Task 5: Full validation and release-quality cleanup

**Files:**
- Modify only files already in scope when a verification failure proves a correction is required.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: a clean, validated dual-host repository ready for user review.

- [ ] **Step 1: Run the complete Node test suite**

Run: `npm test`

Expected: all existing 64 Claude tests plus all new Codex tests PASS with zero failures.

- [ ] **Step 2: Validate the Codex plugin manifest**

Run:

```bash
PYTHONPATH=/Users/baroman/.venv/lib/python3.13/site-packages python3 /Users/baroman/.codex/skills/.system/plugin-creator/scripts/validate_plugin.py codex/plugins/grok-build
```

Expected: `Plugin validation passed`.

If this machine's existing PyYAML path changes, locate another already-installed PyYAML environment. Do not add a repository dependency solely for validation.

- [ ] **Step 3: Validate release metadata and JavaScript syntax**

Run:

```bash
node scripts/bump-version.mjs --check
node --check codex/plugins/grok-build/scripts/grok-bridge.mjs
node --check codex/plugins/grok-build/scripts/lib/grok.mjs
node --check codex/plugins/grok-build/scripts/lib/state.mjs
node --check codex/plugins/grok-build/scripts/lib/tracked-jobs.mjs
node --check codex/plugins/grok-build/scripts/lib/job-control.mjs
```

Expected: version check and every syntax check exit zero.

- [ ] **Step 4: Inspect repository boundaries and diff quality**

Run:

```bash
git diff --check
git status --short
git diff --stat HEAD~4..HEAD
git diff HEAD~4..HEAD -- plugins/grok-build .claude-plugin
```

Expected: no whitespace errors; only planned files are present; the final command shows no Claude plugin or Claude marketplace changes.

- [ ] **Step 5: Correct only evidence-backed failures**

For any failed gate, add or adjust a focused regression test first, verify it fails for the observed reason, make the minimal correction, rerun the focused test, and then repeat Steps 1-4. Do not refactor unrelated upstream code.

- [ ] **Step 6: Commit verification corrections if any**

If Step 5 changed files:

```bash
git add codex/plugins/grok-build tests/codex-package.test.mjs tests/codex-state.test.mjs tests/codex-job-control.test.mjs tests/codex-permissions.test.mjs tests/codex-runtime.test.mjs tests/fake-grok-fixture.mjs scripts/bump-version.mjs tests/bump-version.test.mjs README.md
git commit -m "fix: satisfy Codex plugin validation"
```

If no corrections were needed, do not create an empty commit.
