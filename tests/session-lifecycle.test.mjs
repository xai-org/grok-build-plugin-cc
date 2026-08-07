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

test("repeated SessionStart does not grow CLAUDE_ENV_FILE", () => {
  // SessionStart fires on start, resume, and compaction. Appending grew the file
  // without bound; Claude Code inlines the whole file into every bash -c, and
  // MSYS2 silently truncates past 8186 characters — including false-green exit 0
  // when the cut lands on a line boundary. Assert a bound, not mere presence.
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  const pluginData = makeTempDir();

  assert.equal(fireSessionStart(envFile, pluginData).status, 0);
  const afterFirst = fs.readFileSync(envFile, "utf8");
  assert.match(afterFirst, /export GROK_CC_SESSION_ID='sess-1'/);

  for (let i = 0; i < 8; i += 1) {
    assert.equal(fireSessionStart(envFile, pluginData).status, 0);
  }
  const afterMany = fs.readFileSync(envFile, "utf8");

  assert.equal(
    afterMany.length,
    afterFirst.length,
    `nine identical SessionStart events must not grow the file; grew ${afterFirst.length} -> ${afterMany.length}`
  );
  for (const name of ["GROK_CC_SESSION_ID", "GROK_CC_TRANSCRIPT_PATH", "CLAUDE_PLUGIN_DATA"]) {
    const hits = afterMany.split(/\r?\n/).filter((entry) => entry.trim().startsWith(`export ${name}=`));
    assert.equal(hits.length, 1, `${name} must appear exactly once, found ${hits.length}`);
  }

  assert.equal(fireSessionStart(envFile, pluginData, "sess-2").status, 0);
  const afterChange = fs.readFileSync(envFile, "utf8");
  assert.match(afterChange, /export GROK_CC_SESSION_ID='sess-2'/);
  assert.doesNotMatch(afterChange, /sess-1/);
  assert.ok(
    afterChange.length < 2000,
    `env file must stay small; MSYS2 bash truncates a -c argument past 8186 chars. Got ${afterChange.length}`
  );
});

test("SessionStart rewrites a pre-bloated env file and keeps foreign lines", () => {
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  const pluginData = makeTempDir();
  // Bloat well past whatever the rewritten file will be, so the shrink assertion below
  // does not depend on the length of os.tmpdir() — the rewritten file embeds a temp path,
  // and a fixed expectation here fails on any host whose tmpdir is long enough.
  // GROK_CC_SESSION_ID_BACKUP is a foreign line that shares a prefix with a variable we
  // own, so a rewrite matching on substring rather than on the full name would eat it.
  //
  // The blank line is deliberate too, and for a subtler reason: this fixture was built
  // entirely from non-empty strings, so a rewrite that dropped EVERY blank entry rather
  // than just the split's own trailing one passed this test while silently reformatting
  // any file that did contain blank lines. CLAUDE_ENV_FILE is shared, so those belong to
  // whoever wrote them. A foreign-content test with no blank content in it cannot see that.
  const bloated = [
    "# another hook's header",
    "export OTHER_HOOK='keep-me'",
    "",
    "export GROK_CC_SESSION_ID_BACKUP='keep-me-too'",
    ...Array.from({ length: 20 }, () => "export GROK_CC_SESSION_ID='old'"),
    ...Array.from({ length: 20 }, () => "export GROK_CC_TRANSCRIPT_PATH='/tmp/old.jsonl'"),
    ""
  ].join("\n");
  fs.writeFileSync(envFile, bloated, "utf8");
  const beforeLen = Buffer.byteLength(bloated, "utf8");

  assert.equal(fireSessionStart(envFile, pluginData, "sess-repaired").status, 0);
  const body = fs.readFileSync(envFile, "utf8");

  assert.match(body, /export OTHER_HOOK='keep-me'/);
  assert.match(body, /export GROK_CC_SESSION_ID_BACKUP='keep-me-too'/);
  assert.match(body, /# another hook's header/);
  assert.match(
    body,
    /export OTHER_HOOK='keep-me'\n\nexport GROK_CC_SESSION_ID_BACKUP='keep-me-too'/,
    "a blank line another hook wrote must survive the rewrite"
  );
  assert.match(body, /export GROK_CC_SESSION_ID='sess-repaired'/);
  assert.equal(
    body.split(/\r?\n/).filter((entry) => entry.trim().startsWith("export GROK_CC_SESSION_ID=")).length,
    1
  );
  assert.ok(Buffer.byteLength(body, "utf8") < beforeLen, "bloated file must shrink on rewrite");

  // The bound has to hold with foreign blank lines present, not only on a file this hook
  // owns outright. Dropping exactly one trailing empty is what keeps it: dropping none
  // re-grows the file by a byte per variable per event, and dropping all of them is the
  // over-filter this fixture exists to catch. Without this loop the length claim is only
  // asserted for the easy case.
  const settled = Buffer.byteLength(body, "utf8");
  for (let i = 0; i < 5; i += 1) {
    assert.equal(fireSessionStart(envFile, pluginData, "sess-repaired").status, 0);
  }
  assert.equal(
    Buffer.byteLength(fs.readFileSync(envFile, "utf8"), "utf8"),
    settled,
    "repeated events must not grow a file that contains foreign blank lines"
  );
});

test("unreadable CLAUDE_ENV_FILE aborts rewrite instead of destroying content", () => {
  // A directory at the env-file path yields EISDIR (not ENOENT) on read. The rewrite
  // path must abort rather than treat the failure as empty and whole-file write.
  const dirAsFile = makeTempDir();
  const result = fireSessionStart(dirAsFile, makeTempDir(), "sess-unreadable");

  assert.equal(result.status, 0, `hook must survive an unreadable env file: ${result.stderr}`);
  assert.ok(fs.statSync(dirAsFile).isDirectory(), "the target must be left untouched");
  assert.deepEqual(fs.readdirSync(dirAsFile), []);
});
