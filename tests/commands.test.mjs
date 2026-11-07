import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok-build");

function read(relativePath) {
  return fs.readFileSync(path.join(PLUGIN_ROOT, relativePath), "utf8");
}

test("command set is complete and does not expose continue", () => {
  const commandFiles = fs.readdirSync(path.join(PLUGIN_ROOT, "commands")).sort();
  assert.deepEqual(commandFiles, [
    "check.md",
    "critique.md",
    "delegate.md",
    "import.md",
    "review.md",
    "runs.md",
    "show.md",
    "stop.md"
  ]);
});

test("plugin surfaces use /grok-build names and grok binary, not codex", () => {
  const files = [
    "commands/check.md",
    "commands/review.md",
    "commands/critique.md",
    "commands/delegate.md",
    "commands/runs.md",
    "commands/show.md",
    "commands/stop.md",
    "commands/import.md",
    "agents/grok-delegate.md",
    "hooks/hooks.json",
    "skills/grok-delegate-runtime/SKILL.md",
    "skills/grok-run-output/SKILL.md",
    "scripts/grok-bridge.mjs"
  ];

  for (const file of files) {
    const source = read(file);
    assert.doesNotMatch(source, /\bcodex\b/i, `${file} should not mention codex`);
    assert.doesNotMatch(source, /codex-companion/, `${file} should not reference codex-companion`);
  }

  const bridge = read("scripts/grok-bridge.mjs");
  assert.match(bridge, /grok-bridge/);
  assert.match(bridge, /GROK_BINARY|resolveGrokBinary|getGrokAvailability/);
  assert.doesNotMatch(bridge, /enable-review-gate|stopReviewGate|stop-review-gate/);

  const review = read("commands/review.md");
  assert.match(review, /\/grok-build:review/);
  assert.match(review, /grok-bridge\.mjs" review/);
  assert.match(review, /AskUserQuestion/);
  assert.match(review, /run_in_background:\s*true/);
  assert.match(review, /review --background/);
  assert.match(review, /Prefer the bridge's own detached worker/i);
  assert.match(review, /Bridge `--background` owns the long-running process group/i);
  assert.doesNotMatch(review, /is what actually detaches the run/);
  assert.match(review, /Do not fix issues/i);
  assert.match(review, /return Grok's output verbatim to the user/i);
  assert.match(review, /The bridge script parses `--wait` and `--background`/);
  assert.match(review, /\(Recommended\)/);
  assert.match(review, /--model <model>/);
  assert.match(review, /--effort <low\|medium\|high\|xhigh>/);

  const critique = read("commands/critique.md");
  assert.match(critique, /\/grok-build:critique/);
  assert.match(critique, /critique --background/);
  assert.match(critique, /uses the same review target selection as `\/grok-build:review`/i);
  assert.match(critique, /can still take extra focus text after the flags/i);
  assert.match(critique, /--model <model>/);
  assert.match(critique, /--effort <low\|medium\|high\|xhigh>/);

  const delegate = read("commands/delegate.md");
  assert.match(delegate, /subagent_type: "grok-build:grok-delegate"/);
  assert.match(delegate, /do not call `Skill\(grok-build:grok-delegate\)`/i);
  assert.doesNotMatch(delegate, /^context:\s*fork\b/m);
  assert.match(delegate, /run-resume-candidate --json/);
  assert.match(delegate, /Continue current Grok thread/);
  assert.match(delegate, /Start a new Grok thread/);

  const agent = read("agents/grok-delegate.md");
  assert.match(agent, /grok-bridge\.mjs" run/);
  assert.match(agent, /--resume-last/);
  assert.match(agent, /thin forwarding wrapper/i);

  const hooks = read("hooks/hooks.json");
  assert.match(hooks, /SessionStart/);
  assert.match(hooks, /SessionEnd/);
  assert.doesNotMatch(hooks, /stop-review-gate-hook\.mjs/);
  assert.doesNotMatch(hooks, /"Stop"/);
  assert.match(hooks, /session-lifecycle-hook\.mjs/);

  const importCmd = read("commands/import.md");
  assert.match(importCmd, /grok -r <session-id>/);
  assert.match(importCmd, /grok-bridge\.mjs" import/);

  const check = read("commands/check.md");
  assert.match(check, /grok-bridge\.mjs" check --json/);
  assert.doesNotMatch(check, /enable-review-gate|disable-review-gate/);

  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  assert.match(readme, /### `\/grok-build:check`/);
  assert.match(readme, /### `\/grok-build:review`/);
  assert.match(readme, /### `\/grok-build:critique`/);
  assert.match(readme, /### `\/grok-build:delegate`/);
  assert.match(readme, /### `\/grok-build:import`/);
  assert.match(readme, /### `\/grok-build:runs`/);
  assert.match(readme, /### `\/grok-build:show`/);
  assert.match(readme, /### `\/grok-build:stop`/);
  assert.match(readme, /plugin install grok-build@xai-grok-build/);
  assert.doesNotMatch(readme, /\bcodex\b/i);
  assert.doesNotMatch(readme, /review-gate|enable-review-gate/i);
});

test("runtime skill only forwards run once", () => {
  const runtimeSkill = read("skills/grok-delegate-runtime/SKILL.md");
  assert.match(runtimeSkill, /grok-bridge\.mjs" run "<raw arguments>"/);
  assert.match(runtimeSkill, /Use `run` for every delegate request/i);
  assert.match(runtimeSkill, /run --resume-last/i);
  assert.match(runtimeSkill, /Do not call `check`, `review`, `critique`, `runs`, `show`, or `stop`/);
  assert.match(runtimeSkill, /natural-language task text/);

  const resultHandling = read("skills/grok-run-output/SKILL.md");
  assert.match(resultHandling, /do not turn a failed or incomplete Grok run into a Claude-side implementation attempt/i);
  assert.match(resultHandling, /if Grok was never successfully invoked, do not generate a substitute answer at all/i);
});
