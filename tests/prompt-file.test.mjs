import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, writeExecutable } from "./helpers.mjs";
import { promptNeedsFile, runHeadlessAgent } from "../plugins/grok-build/scripts/lib/grok.mjs";

// A grok stand-in that, like the real CLI, takes the prompt either as `-p <prompt>` or from `--prompt-file <path>`,
// and writes what it received to FAKE_GROK_PROMPT_COPY so the test can compare.
function installPromptEchoGrok(binDir) {
  writeExecutable(
    path.join(binDir, "grok"),
    `#!/usr/bin/env node
import fs from "node:fs";
const argv = process.argv.slice(2);
const at = (flag) => { const i = argv.indexOf(flag); return i === -1 ? null : (argv[i + 1] ?? null); };
const file = at("--prompt-file");
const prompt = file ? fs.readFileSync(file, "utf8") : (at("-p") ?? "");
if (process.env.FAKE_GROK_PROMPT_COPY) fs.writeFileSync(process.env.FAKE_GROK_PROMPT_COPY, prompt);
process.stdout.write("Handled the requested task.\\n");
`
  );
  return { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}` };
}

test("a prompt above the argv limit goes through --prompt-file, and the file is removed once grok exits", async () => {
  const env = installPromptEchoGrok(makeTempDir());
  const copy = path.join(makeTempDir(), "seen.txt");
  // A critique prompt with two inlined 20 KB files lands around here; Linux refuses one argv string past 128 KiB.
  const prompt = `Review this diff.\n${"x".repeat(200 * 1024)}`;

  const result = await runHeadlessAgent(makeTempDir(), { prompt, env: { ...env, FAKE_GROK_PROMPT_COPY: copy } });

  assert.equal(result.status, 0);
  assert.ok(!result.args.includes("-p"), "the prompt must not travel as a -p argument");
  const at = result.args.indexOf("--prompt-file");
  assert.ok(at !== -1, "expected --prompt-file in argv");
  assert.equal(fs.readFileSync(copy, "utf8"), prompt, "grok must read the whole prompt from the file");
  assert.equal(fs.existsSync(result.args[at + 1]), false, "the prompt file is removed after the run");
});

test("a prompt that starts with a dash goes through --prompt-file", async () => {
  const env = installPromptEchoGrok(makeTempDir());
  const copy = path.join(makeTempDir(), "seen.txt");

  const result = await runHeadlessAgent(makeTempDir(), {
    prompt: "--help is what I typed; explain this flag",
    env: { ...env, FAKE_GROK_PROMPT_COPY: copy }
  });

  assert.equal(result.status, 0);
  assert.ok(!result.args.includes("-p"));
  assert.ok(result.args.includes("--prompt-file"));
  assert.equal(fs.readFileSync(copy, "utf8"), "--help is what I typed; explain this flag");
});

test("a short prompt stays on -p", async () => {
  const env = installPromptEchoGrok(makeTempDir());
  const copy = path.join(makeTempDir(), "seen.txt");

  const result = await runHeadlessAgent(makeTempDir(), { prompt: "check the thing", env: { ...env, FAKE_GROK_PROMPT_COPY: copy } });

  assert.equal(result.status, 0);
  assert.ok(result.args.includes("-p"));
  assert.ok(!result.args.includes("--prompt-file"));
  assert.equal(fs.readFileSync(copy, "utf8"), "check the thing");
});

test("promptNeedsFile applies the Windows command-line cap and the Linux per-argument cap", () => {
  assert.equal(promptNeedsFile("x".repeat(20 * 1024), "win32"), true);
  assert.equal(promptNeedsFile("x".repeat(20 * 1024), "linux"), false);
  assert.equal(promptNeedsFile("x".repeat(70 * 1024), "linux"), true);
  assert.equal(promptNeedsFile("x".repeat(70 * 1024), "darwin"), true);
  assert.equal(promptNeedsFile("-h", "linux"), true);
  assert.equal(promptNeedsFile("plain prompt", "win32"), false);
});
