import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { upsertJob, writeJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";
import { buildStatusSnapshot } from "../plugins/grok-build/scripts/lib/job-control.mjs";
import { createProgressReporter } from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";

function withPluginData(fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  try {
    return fn();
  } finally {
    if (previous == null) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
  }
}

test("buildStatusSnapshot still surfaces finished runs when the window is full of active runs", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const put = (id, status, t) => {
      const job = { id, status, phase: status, title: id, updatedAt: `2026-01-01T00:00:${t}Z` };
      writeJobFile(workspace, id, job);
      upsertJob(workspace, job);
    };
    // 8 running (newest), then 5 completed (older)
    for (let i = 0; i < 8; i++) put(`run-${i}`, "running", String(50 + i).padStart(2, "0"));
    for (let i = 0; i < 5; i++) put(`done-${i}`, "completed", String(10 + i).padStart(2, "0"));

    const snap = buildStatusSnapshot(workspace, { maxJobs: 8 });
    assert.equal(snap.running.length, 8);
    assert.ok(snap.latestFinished, "a latestFinished is reported");
    // The 4 completed runs other than latestFinished must still appear.
    assert.equal(snap.recent.length, 4);
    assert.ok(snap.recent.every((j) => j.status === "completed"));
  });
});

test("createProgressReporter normalizes a missing agentPid to null, not 0", () => {
  const seen = [];
  const report = createProgressReporter({ onEvent: (e) => seen.push(e) });
  report({ message: "hello", phase: "running" }); // no agentPid
  assert.equal(seen.length, 1);
  assert.equal(seen[0].agentPid, null);
});
