import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import {
  buildReviewPrompt,
  DEFAULT_IDLE_TIMEOUT_MS,
  formatIdleDuration,
  getGrokAuthStatus,
  getGrokAvailability,
  IDLE_TIMEOUT_ENV,
  parseStructuredOutput,
  resolveGrokBinary,
  resolveIdleTimeoutMs,
  runHeadlessAgent,
  runImport
} from "../plugins/grok-build/scripts/lib/grok.mjs";
import { runCommand } from "../plugins/grok-build/scripts/lib/process.mjs";

test("resolveGrokBinary prefers GROK_BINARY override", () => {
  assert.equal(resolveGrokBinary({ GROK_BINARY: "/custom/grok" }), "/custom/grok");
  assert.equal(resolveGrokBinary({}), "grok");
});

test("getGrokAvailability reports available with fake grok on PATH", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);

  const status = getGrokAvailability(process.cwd(), { env });
  assert.equal(status.available, true);
  assert.match(status.detail, /0\.2\.83-fake|ok/i);
});

test("getGrokAuthStatus uses models probe success as logged in", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);

  const auth = getGrokAuthStatus(process.cwd(), { env });
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.source, "models-probe");
});

test("getGrokAuthStatus treats failed models as not logged in", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "not-logged-in");
  const env = buildEnv(binDir);

  const auth = getGrokAuthStatus(process.cwd(), { env });
  assert.equal(auth.loggedIn, false);
  assert.match(auth.detail, /Not logged in|not logged in|failed/i);
});

test("runHeadlessAgent captures stdout and session id from fake grok", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  const cwd = makeTempDir();

  const result = await runHeadlessAgent(cwd, {
    prompt: "check the thing",
    env,
    permissionMode: "plan",
    sandbox: "read-only"
  });

  assert.equal(result.status, 0);
  assert.match(result.finalMessage, /Handled the requested task/);
  assert.equal(typeof result.threadId, "string");
  assert.ok(result.threadId.length > 0);
  assert.ok(result.args.includes("-p"));
  assert.ok(result.args.includes("--permission-mode"));
  assert.ok(result.args.includes("plan"));
});

test("runImport parses session id from fake grok json output", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  const sourcePath = path.join(makeTempDir(), "sess.jsonl");

  const result = runImport(process.cwd(), {
    sourcePath,
    env
  });

  assert.equal(result.sessionId, "11111111-2222-4333-8444-555555555555");
  assert.equal(result.resumeCommand, "grok -r 11111111-2222-4333-8444-555555555555");
});

test("parseStructuredOutput extracts fenced JSON", () => {
  const raw = 'Here you go:\n```json\n{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}\n```\n';
  const parsed = parseStructuredOutput(raw);
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
});

test("parseStructuredOutput does not let fallback clobber canonical fields", () => {
  const parsed = parseStructuredOutput('{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}', {
    parsed: { verdict: "needs-attention" },
    parseError: "stale",
    rawOutput: "stale",
    status: 7
  });
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
  assert.equal(parsed.status, 7);
});

test("runHeadlessAgent reports agentPid from the spawned child", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  const cwd = makeTempDir();
  const progressEvents = [];

  const result = await runHeadlessAgent(cwd, {
    prompt: "pid check",
    env,
    onProgress: (event) => progressEvents.push(event)
  });

  assert.equal(typeof result.agentPid, "number");
  assert.ok(result.agentPid > 0);
  assert.ok(progressEvents.some((event) => event?.agentPid === result.agentPid));
});

test("resolveIdleTimeoutMs prefers the option, then the env, then the default", () => {
  assert.equal(resolveIdleTimeoutMs(undefined, {}), DEFAULT_IDLE_TIMEOUT_MS);
  assert.equal(resolveIdleTimeoutMs(undefined, { [IDLE_TIMEOUT_ENV]: "120000" }), 120000);
  assert.equal(resolveIdleTimeoutMs(5000, { [IDLE_TIMEOUT_ENV]: "120000" }), 5000);
  assert.equal(resolveIdleTimeoutMs(0, { [IDLE_TIMEOUT_ENV]: "120000" }), 0);
  assert.equal(resolveIdleTimeoutMs(undefined, { [IDLE_TIMEOUT_ENV]: "0" }), 0);
  assert.equal(resolveIdleTimeoutMs(undefined, { [IDLE_TIMEOUT_ENV]: "-5" }), 0);
  assert.equal(resolveIdleTimeoutMs(undefined, { [IDLE_TIMEOUT_ENV]: "soon" }), 0);
  assert.equal(resolveIdleTimeoutMs("2500.9", {}), 2500);
});

test("formatIdleDuration renders seconds and minutes", () => {
  assert.equal(formatIdleDuration(45_000), "45s");
  assert.equal(formatIdleDuration(60_000), "1m");
  assert.equal(formatIdleDuration(15 * 60_000), "15m");
  assert.equal(formatIdleDuration(90_000), "1m 30s");
});

test("runHeadlessAgent terminates a silent grok process as stalled and keeps its output", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "hang-print");
  const env = buildEnv(binDir);
  const cwd = makeTempDir();
  const progressEvents = [];

  const startedAt = Date.now();
  const result = await runHeadlessAgent(cwd, {
    prompt: "finish, then get held by a hook",
    env,
    idleTimeoutMs: 1500,
    onProgress: (event) => progressEvents.push(event)
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.stalled, true);
  assert.equal(result.idleTimeoutMs, 1500);
  assert.notEqual(result.status, 0);
  assert.match(result.finalMessage, /Partial answer before the hook held the process/);
  assert.ok(elapsedMs < 20_000, `stalled run took ${elapsedMs}ms to resolve`);
  assert.ok(
    progressEvents.some((event) => event?.phase === "stalled"),
    `expected a stalled progress event, got ${JSON.stringify(progressEvents)}`
  );
  assert.ok(result.agentPid > 0);
  assert.throws(() => process.kill(result.agentPid, 0), /ESRCH|EPERM/);
});

test("runHeadlessAgent leaves a normal run alone when the idle watchdog is armed", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir);
  const cwd = makeTempDir();

  const result = await runHeadlessAgent(cwd, {
    prompt: "quick task",
    env,
    idleTimeoutMs: 10_000
  });

  assert.equal(result.stalled, false);
  assert.equal(result.status, 0);
  assert.match(result.finalMessage, /Handled the requested task/);
});

test("runHeadlessAgent honours an idle watchdog disabled via the environment", async () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir, { [IDLE_TIMEOUT_ENV]: "0" });
  const cwd = makeTempDir();

  const result = await runHeadlessAgent(cwd, { prompt: "quick task", env });

  assert.equal(result.idleTimeoutMs, 0);
  assert.equal(result.stalled, false);
  assert.equal(result.status, 0);
});

test("buildReviewPrompt includes target and focus", () => {
  const prompt = buildReviewPrompt({
    targetLabel: "working tree diff",
    focusText: "auth boundaries",
    collectionGuidance: "Use the repository context below as primary evidence.",
    reviewInput: "## Git Status\n M app.js"
  });
  assert.match(prompt, /working tree diff/);
  assert.match(prompt, /auth boundaries/);
  assert.match(prompt, /Git Status/);
});

test("live grok --help advertises headless flags when grok is on PATH", () => {
  const help = runCommand("grok", ["--help"], { cwd: process.cwd() });
  if (help.error?.code === "ENOENT" || help.status !== 0) {
    // Optional smoke only when a real grok binary is available.
    return;
  }
  const text = `${help.stdout}\n${help.stderr}`;
  for (const flag of [
    "-p",
    "--single",
    "-r",
    "--resume",
    "--session-id",
    "--always-approve",
    "--agent",
    "--permission-mode",
    "--sandbox",
    "--output-format",
    "--json-schema",
    "--effort"
  ]) {
    assert.match(text, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("parseStructuredOutput skips a non-JSON fence that precedes the JSON block", () => {
  const raw = [
    "I ran the suite first:",
    "```bash",
    "npm test",
    "```",
    "Then the review:",
    "```json",
    '{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}',
    "```"
  ].join("\n");
  const parsed = parseStructuredOutput(raw);
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "approve");
});

test("parseStructuredOutput prefers the json-tagged fence over an untagged one", () => {
  const raw = "```\nnot json\n```\n```json\n{\"verdict\":\"needs-attention\",\"summary\":\"x\",\"findings\":[],\"next_steps\":[]}\n```";
  const parsed = parseStructuredOutput(raw);
  assert.equal(parsed.parseError, null);
  assert.equal(parsed.parsed.verdict, "needs-attention");
});

test("parseStructuredOutput still reads a single-line fence and reports the JSON error when nothing parses", () => {
  const inline = parseStructuredOutput('```{"verdict":"approve","summary":"ok","findings":[],"next_steps":[]}```');
  assert.equal(inline.parseError, null);
  assert.equal(inline.parsed.verdict, "approve");

  const broken = parseStructuredOutput("```json\n{\"verdict\": }\n```");
  assert.equal(broken.parsed, null);
  assert.match(broken.parseError, /JSON/);
});
