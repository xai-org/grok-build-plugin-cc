import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { resolveCancelableJob, resolveResultJob } from "../plugins/grok-build/scripts/lib/job-control.mjs";
import { upsertJob } from "../plugins/grok-build/scripts/lib/state.mjs";

function seedWorkspace() {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "run-active-1", status: "running", kind: "task" });
  upsertJob(workspace, { id: "run-done-1", status: "completed", kind: "task" });
  return workspace;
}

test("resolveResultJob says a referenced run is still running instead of not found", () => {
  const workspace = seedWorkspace();

  assert.throws(() => resolveResultJob(workspace, "run-active"), {
    message: /Run run-active-1 is still running/
  });
});

test("resolveResultJob keeps the not-found message for an unknown reference", () => {
  const workspace = seedWorkspace();

  assert.throws(() => resolveResultJob(workspace, "nope"), {
    message: /No run found for "nope"/
  });
});

test("resolveResultJob still resolves a finished run by prefix", () => {
  const workspace = seedWorkspace();

  const { job } = resolveResultJob(workspace, "run-done");
  assert.equal(job.id, "run-done-1");
});

test("resolveCancelableJob reports the status of a referenced finished run", () => {
  const workspace = seedWorkspace();

  assert.throws(() => resolveCancelableJob(workspace, "run-done"), {
    message: /Run run-done-1 is already completed/
  });
});

test("resolveCancelableJob keeps the not-found message for an unknown reference", () => {
  const workspace = seedWorkspace();

  assert.throws(() => resolveCancelableJob(workspace, "nope"), {
    message: /No run found for "nope"/
  });
});

test("resolveCancelableJob still resolves an active run by prefix", () => {
  const workspace = seedWorkspace();

  const { job } = resolveCancelableJob(workspace, "run-active");
  assert.equal(job.id, "run-active-1");
});
