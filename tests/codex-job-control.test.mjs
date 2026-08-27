import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import { upsertJob, writeJobFile } from "../codex/plugins/grok-build/scripts/lib/state.mjs";
import { createJobRecord, createProgressReporter } from "../codex/plugins/grok-build/scripts/lib/tracked-jobs.mjs";
import {
  buildStatusSnapshot,
  resolveCancelableJob,
  resolveResultJob
} from "../codex/plugins/grok-build/scripts/lib/job-control.mjs";

function withCodexData(fn) {
  const previous = process.env.GROK_CODEX_DATA;
  process.env.GROK_CODEX_DATA = makeTempDir();
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.GROK_CODEX_DATA;
    } else {
      process.env.GROK_CODEX_DATA = previous;
    }
  }
}

function seedJob(workspaceRoot, job) {
  writeJobFile(workspaceRoot, job.id, job);
  upsertJob(workspaceRoot, job);
}

test("createJobRecord omits sessionId", () => {
  withCodexData(() => {
    const previousSession = process.env.GROK_CC_SESSION_ID;
    process.env.GROK_CC_SESSION_ID = "claude-session-should-be-ignored";
    try {
      const workspaceRoot = makeTempDir();
      const record = createJobRecord({ id: "run-1", workspaceRoot, status: "queued" });
      assert.equal(Object.hasOwn(record, "sessionId"), false);
    } finally {
      if (previousSession == null) {
        delete process.env.GROK_CC_SESSION_ID;
      } else {
        process.env.GROK_CC_SESSION_ID = previousSession;
      }
    }
  });
});

test("buildStatusSnapshot lists jobs for the whole workspace", () => {
  withCodexData(() => {
    const previousSession = process.env.GROK_CC_SESSION_ID;
    process.env.GROK_CC_SESSION_ID = "session-a";
    try {
      const workspaceRoot = makeTempDir();
      seedJob(workspaceRoot, {
        id: "job-a",
        status: "running",
        sessionId: "session-a",
        updatedAt: "2026-08-02T00:00:00.000Z",
        createdAt: "2026-08-02T00:00:00.000Z",
        title: "A"
      });
      seedJob(workspaceRoot, {
        id: "job-b",
        status: "running",
        sessionId: "session-b",
        updatedAt: "2026-08-01T00:00:00.000Z",
        createdAt: "2026-08-01T00:00:00.000Z",
        title: "B"
      });
      seedJob(workspaceRoot, {
        id: "job-c",
        status: "completed",
        sessionId: "session-b",
        updatedAt: "2026-08-03T00:00:00.000Z",
        createdAt: "2026-08-03T00:00:00.000Z",
        title: "C"
      });

      const snapshot = buildStatusSnapshot(workspaceRoot);
      assert.deepEqual(snapshot.running.map((job) => job.id).sort(), ["job-a", "job-b"]);
      assert.equal(snapshot.latestFinished.id, "job-c");
    } finally {
      if (previousSession == null) {
        delete process.env.GROK_CC_SESSION_ID;
      } else {
        process.env.GROK_CC_SESSION_ID = previousSession;
      }
    }
  });
});

test("resolveResultJob without a reference selects the latest finished workspace job", () => {
  withCodexData(() => {
    const workspaceRoot = makeTempDir();
    seedJob(workspaceRoot, {
      id: "job-old-finished",
      status: "completed",
      updatedAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      title: "Old"
    });
    seedJob(workspaceRoot, {
      id: "job-new-finished",
      status: "failed",
      updatedAt: "2026-08-03T00:00:00.000Z",
      createdAt: "2026-08-03T00:00:00.000Z",
      title: "New"
    });
    seedJob(workspaceRoot, {
      id: "job-running",
      status: "running",
      updatedAt: "2026-08-04T00:00:00.000Z",
      createdAt: "2026-08-04T00:00:00.000Z",
      title: "Running"
    });

    const { job } = resolveResultJob(workspaceRoot);
    assert.equal(job.id, "job-new-finished");
  });
});

test("resolveCancelableJob without a reference throws when two jobs are active", () => {
  withCodexData(() => {
    const workspaceRoot = makeTempDir();
    seedJob(workspaceRoot, {
      id: "job-active-1",
      status: "running",
      updatedAt: "2026-08-02T00:00:00.000Z",
      createdAt: "2026-08-02T00:00:00.000Z",
      title: "One"
    });
    seedJob(workspaceRoot, {
      id: "job-active-2",
      status: "queued",
      updatedAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-08-01T00:00:00.000Z",
      title: "Two"
    });

    assert.throws(
      () => resolveCancelableJob(workspaceRoot),
      /Multiple Grok Build runs are active/
    );
  });
});

test("progress reporter prefixes stderr with [grok-codex]", () => {
  const chunks = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    const reporter = createProgressReporter({ stderr: true });
    reporter("hello");
    assert.equal(chunks.join(""), "[grok-codex] hello\n");
  } finally {
    process.stderr.write = originalWrite;
  }
});
