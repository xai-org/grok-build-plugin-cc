import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

import { makeTempDir, run } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = path.join(ROOT, "plugins", "grok-build", "scripts", "session-lifecycle-hook.mjs");

function fireSessionStart(envFile, pluginData, sessionId = "sess-1") {
  return run(process.execPath, [HOOK, "SessionStart"], {
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginData
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: sessionId,
      transcript_path: "C:\\tmp\\transcript.jsonl"
    })
  });
}

test("SessionStart hands a foreign CRLF line back unchanged", () => {
  // CLAUDE_ENV_FILE is shared with other hooks, and the rewrite comments promise not
  // to reformat their content. Splitting on /\r?\n/ and joining with \n keeps that
  // promise for blank lines but breaks it for line endings: a foreign line written
  // CRLF comes back LF-only. Assert the exact bytes — a line-count or a normalising
  // read cannot see this, which is why it survived review.
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  const pluginData = makeTempDir();

  const seeded =
    "export OTHER_HOOK_CRLF='crlf-value'\r\n" +
    "export OTHER_HOOK_LF='lf-value'\n" +
    "export GROK_CC_SESSION_ID='old'\r\n";
  fs.writeFileSync(envFile, seeded, "utf8");

  assert.equal(fireSessionStart(envFile, pluginData, "sess-crlf").status, 0);
  const body = fs.readFileSync(envFile, "utf8");

  assert.ok(
    body.includes("export OTHER_HOOK_CRLF='crlf-value'\r\n"),
    `a foreign CRLF line must survive byte for byte, got ${JSON.stringify(body)}`
  );
  assert.ok(
    body.includes("export OTHER_HOOK_LF='lf-value'\n"),
    `a foreign LF line must stay LF, got ${JSON.stringify(body)}`
  );

  // The rewrite still has to do its own job on top of preserving theirs.
  assert.match(body, /export GROK_CC_SESSION_ID='sess-crlf'/);
  assert.doesNotMatch(body, /'old'/);
  assert.equal(
    body.split(/\r?\n/).filter((entry) => entry.trim().startsWith("export GROK_CC_SESSION_ID=")).length,
    1
  );
});
