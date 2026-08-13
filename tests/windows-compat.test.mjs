import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run, writeExecutable } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "plugins", "grok-build", "scripts", "grok-bridge.mjs");
const HOOK = path.join(ROOT, "plugins", "grok-build", "scripts", "session-lifecycle-hook.mjs");

test("writeExecutable installs a PATHEXT-visible shim on Windows", () => {
  const dir = makeTempDir();
  const scriptPath = path.join(dir, "grok");
  writeExecutable(scriptPath, "#!/usr/bin/env node\nconsole.log('ok')\n");
  assert.ok(fs.existsSync(scriptPath));
  if (process.platform === "win32") {
    assert.ok(fs.existsSync(`${scriptPath}.cmd`), "expected grok.cmd next to extensionless script");
  }
});

test("SessionStart upserts CLAUDE_ENV_FILE instead of appending forever", () => {
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  const payload = JSON.stringify({
    session_id: "sess-1",
    transcript_path: "/tmp/t.jsonl"
  });
  const env = { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: "/tmp/plugin-data" };
  for (let i = 0; i < 8; i++) {
    const result = run("node", [HOOK, "SessionStart"], { env, input: payload });
    assert.equal(result.status, 0, result.stderr);
  }
  const text = fs.readFileSync(envFile, "utf8");
  const sessionLines = text.split("\n").filter((line) => line.startsWith("export GROK_CC_SESSION_ID="));
  assert.equal(sessionLines.length, 1, text);
});

test("run --prompt-file forwards a path instead of inlining into -p", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeGrokLog = path.join(pluginDataDir, "fake-grok.log");
  installFakeGrok(binDir);
  initGitRepo(repo);
  const promptPath = path.join(repo, "big-prompt.txt");
  fs.writeFileSync(promptPath, "x".repeat(4000));

  const result = run("node", [SCRIPT, "run", "--prompt-file", promptPath], {
    cwd: repo,
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir, FAKE_GROK_LOG: fakeGrokLog })
  });
  assert.equal(result.status, 0, result.stderr);

  const lines = fs
    .readFileSync(fakeGrokLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const headless = [...lines].reverse().find((entry) => entry.argv?.includes("--prompt-file") || entry.argv?.includes("-p"));
  assert.ok(headless, "expected a headless grok invocation");
  assert.ok(headless.argv.includes("--prompt-file"), headless.argv.join(" "));
  assert.ok(!headless.argv.includes("-p"), headless.argv.join(" "));
});

test("bridge still runs when invoked through a symlink to the script", (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  const linkDir = makeTempDir();
  const link = path.join(linkDir, "grok-bridge.mjs");
  try {
    fs.symlinkSync(SCRIPT, link);
  } catch (error) {
    t.skip(`symlink not permitted: ${error.message}`);
    return;
  }

  const result = run("node", [link, "check", "--json"], {
    cwd: repo,
    env: buildEnv(binDir, { CLAUDE_PLUGIN_DATA: pluginDataDir })
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\{|"ok"|available/i);
});
