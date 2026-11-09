import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";

const hookPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../plugins/grok-build/scripts/session-lifecycle-hook.mjs"
);

test("SessionStart exports a plugin-owned data dir name, not the generic CLAUDE_PLUGIN_DATA", () => {
  const envFile = path.join(makeTempDir(), "env.sh");
  const pluginDataDir = makeTempDir();
  const result = spawnSync(process.execPath, [hookPath, "SessionStart"], {
    input: JSON.stringify({ session_id: "sess-1", transcript_path: "/tmp/t.jsonl" }),
    env: { ...process.env, CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: pluginDataDir },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);

  const written = fs.readFileSync(envFile, "utf8");
  assert.match(written, /^export GROK_BUILD_PLUGIN_DATA=/m);
  assert.doesNotMatch(written, /^export CLAUDE_PLUGIN_DATA=/m);
  assert.ok(written.includes(pluginDataDir));
});
