import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok-build");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "grok-bridge.mjs");

function pluginDataEnv(pluginDataDir, binDir, extra = {}) {
  return buildEnv(binDir, {
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    GROK_BINARY: path.join(binDir, "grok"),
    ...extra
  });
}

function lastFakeGrokArgv(logPath) {
  const lines = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const printRun = [...lines].reverse().find((entry) => entry.argv?.includes("-p"));
  assert.ok(printRun, "expected a headless grok -p invocation");
  return printRun.argv;
}

function setupRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeGrokLog = path.join(pluginDataDir, "fake-grok.log");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 1;\n");
  run("git", ["add", "src.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 2;\n");
  return { repo, binDir, pluginDataDir, fakeGrokLog };
}

// Regression tests for https://github.com/xai-org/grok-build-plugin-cc/issues/5
//
// Headless runs (review, and `run` without --write) have no user who can
// click Approve, so passing --permission-mode plan with no auto-approve
// left every tool call with nobody able to approve it. The sandbox
// (--sandbox read-only) is the real safety boundary for these paths, so
// auto-approve is safe to combine with it.

test("review passes --always-approve alongside --sandbox read-only", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_GROK_LOG: fakeGrokLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const argv = lastFakeGrokArgv(fakeGrokLog);
  assert.ok(argv.includes("--always-approve"), argv.join(" "));
  assert.ok(argv.includes("--sandbox"), argv.join(" "));
  assert.equal(argv[argv.indexOf("--sandbox") + 1], "read-only");
});

test("run without --write passes --always-approve alongside --sandbox read-only", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();

  const result = run("node", [SCRIPT, "run", "check auth preflight"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_GROK_LOG: fakeGrokLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const argv = lastFakeGrokArgv(fakeGrokLog);
  assert.ok(argv.includes("--always-approve"), argv.join(" "));
  assert.ok(argv.includes("--sandbox"), argv.join(" "));
  assert.equal(argv[argv.indexOf("--sandbox") + 1], "read-only");
});

test("run forwards allow, deny, max-turns, and permission-mode", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();

  const result = run(
    process.execPath,
    [
      SCRIPT,
      "run",
      "--write",
      "--permission-mode",
      "acceptEdits",
      "--max-turns",
      "30",
      "--allow",
      "Bash(npm test)",
      "--allow",
      "Bash(grep *)",
      "--deny",
      "Edit(generated/**)",
      "make the change"
    ],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, { FAKE_GROK_LOG: fakeGrokLog }),
      shell: false
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const argv = lastFakeGrokArgv(fakeGrokLog);
  assert.equal(argv[argv.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(argv[argv.indexOf("--max-turns") + 1], "30");
  const allowRules = argv.filter((_, index) => argv[index - 1] === "--allow");
  const denyRules = argv.filter((_, index) => argv[index - 1] === "--deny");
  assert.deepEqual(allowRules, ["Bash(npm test)", "Bash(grep *)"]);
  assert.deepEqual(denyRules, ["Edit(generated/**)"]);
  assert.ok(argv.includes("--always-approve"), argv.join(" "));
  assert.ok(!argv.includes("--sandbox"), argv.join(" "));
});

test("run without bounds does not invent allow, deny, or max-turns", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();

  const result = run("node", [SCRIPT, "run", "--write", "make the change"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_GROK_LOG: fakeGrokLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const argv = lastFakeGrokArgv(fakeGrokLog);
  assert.ok(!argv.includes("--allow"), argv.join(" "));
  assert.ok(!argv.includes("--deny"), argv.join(" "));
  assert.ok(!argv.includes("--max-turns"), argv.join(" "));
  assert.ok(!argv.includes("--permission-mode"), argv.join(" "));
});

test("run rejects an unknown permission mode before launching grok", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();

  const result = run("node", [SCRIPT, "run", "--permission-mode", "yolo", "make the change"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_GROK_LOG: fakeGrokLog })
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unsupported permission mode/);
  assert.equal(fs.existsSync(fakeGrokLog), false);
});

test("run with --write passes --always-approve without a sandbox flag", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupRepo();

  const result = run("node", [SCRIPT, "run", "--write", "make the change"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_GROK_LOG: fakeGrokLog })
  });

  assert.equal(result.status, 0, result.stderr);
  const argv = lastFakeGrokArgv(fakeGrokLog);
  assert.ok(argv.includes("--always-approve"), argv.join(" "));
  assert.ok(!argv.includes("--sandbox"), argv.join(" "));
});
