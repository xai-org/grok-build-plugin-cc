import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";
import {
  buildReviewPrompt,
  getGrokAuthStatus,
  getGrokAvailability,
  parseStructuredOutput,
  resolveGrokBinary,
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
  assert.equal(auth.verified, true);
  assert.equal(auth.authMethod, "grok-cli");
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

test("getGrokAuthStatus treats a zero-exit unauthenticated probe as not logged in", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir, "not-authenticated");
  const env = buildEnv(binDir);

  const auth = getGrokAuthStatus(process.cwd(), { env });
  assert.equal(auth.loggedIn, false);
  assert.equal(auth.verified, false);
  assert.equal(auth.authMethod, null);
  assert.match(auth.detail, /not authenticated/i);
});

for (const [banner, authMethod] of [
  ["You are using XAI_API_KEY.", "xai-api-key"],
  ["You are logged in with grok.com.", "grok-cli"],
  ["Model 'grok-code-fast-1' is using its own API key.", "model-api-key"],
  ["You are authenticated via deployment key.", "deployment-key"]
]) {
  test(`getGrokAuthStatus reports verified login for banner: ${banner}`, () => {
    const binDir = makeTempDir();
    installFakeGrok(binDir);
    const env = buildEnv(binDir, { FAKE_GROK_MODELS_BANNER: banner });

    const auth = getGrokAuthStatus(process.cwd(), { env });
    assert.equal(auth.loggedIn, true);
    assert.equal(auth.verified, true);
    assert.equal(auth.authMethod, authMethod);
    assert.equal(auth.detail, banner);
  });
}

test("getGrokAuthStatus does not block on an unrecognized banner, but leaves it unverified", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir, { FAKE_GROK_MODELS_BANNER: "Signed in through some future method." });

  const auth = getGrokAuthStatus(process.cwd(), { env });
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.verified, false);
  assert.equal(auth.authMethod, null);
});

test("getGrokAuthStatus reads the banner through CRLF line endings", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir, { FAKE_GROK_MODELS_BANNER: "You are not authenticated.\r" });

  const auth = getGrokAuthStatus(process.cwd(), { env });
  assert.equal(auth.loggedIn, false);
  assert.equal(auth.detail, "You are not authenticated.");
});

for (const [label, banner] of [
  ["a banner below the first line", "Some new first line.\nYou are using XAI_API_KEY."],
  ["wording appended to a known banner", "You are using XAI_API_KEY. Authentication failed."]
]) {
  test(`getGrokAuthStatus does not verify ${label}`, () => {
    const binDir = makeTempDir();
    installFakeGrok(binDir);
    const env = buildEnv(binDir, { FAKE_GROK_MODELS_BANNER: banner });

    const auth = getGrokAuthStatus(process.cwd(), { env });
    assert.equal(auth.loggedIn, true);
    assert.equal(auth.verified, false);
    assert.equal(auth.authMethod, null);
  });
}

test("getGrokAuthStatus only honors the unauthenticated banner on the first line", () => {
  const binDir = makeTempDir();
  installFakeGrok(binDir);
  const env = buildEnv(binDir, {
    FAKE_GROK_MODELS_BANNER: "You are using XAI_API_KEY.\nYou are not authenticated."
  });

  const auth = getGrokAuthStatus(process.cwd(), { env });
  assert.equal(auth.loggedIn, true);
  assert.equal(auth.verified, true);
  assert.equal(auth.authMethod, "xai-api-key");
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
