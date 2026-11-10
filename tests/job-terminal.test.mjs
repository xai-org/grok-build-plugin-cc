import { spawn } from "node:child_process";
import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  claimJobTerminal,
  patchJobIfActive,
  readJobFile,
  resolveJobFile,
  upsertJob,
  writeJobFile
} from "../plugins/grok-build/scripts/lib/state.mjs";
import { resolveJobKillTargets } from "../plugins/grok-build/scripts/lib/tracked-jobs.mjs";
import { handleCancel } from "../plugins/grok-build/scripts/grok-bridge.mjs";

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, { timeoutMs = 2000, intervalMs = 20 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

function withPluginData(fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  try {
    return fn();
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
}

test("claimJobTerminal: cancelled wins over completed", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-cas-1";
    const running = {
      id: jobId,
      status: "running",
      phase: "running",
      title: "CAS",
      bridgePid: 11,
      agentPid: 22,
      pid: 11
    };
    writeJobFile(workspace, jobId, running);
    upsertJob(workspace, running);

    const cancel = claimJobTerminal(workspace, jobId, "cancelled", {
      errorMessage: "Stopped by user."
    });
    assert.equal(cancel.claimed, true);
    assert.equal(cancel.status, "cancelled");

    const complete = claimJobTerminal(workspace, jobId, "completed", {
      result: { rawOutput: "too late" },
      rendered: "too late\n"
    });
    assert.equal(complete.claimed, false);
    assert.equal(complete.status, "cancelled");
    assert.equal(complete.reason, "cancelled-wins");

    const stored = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(stored.status, "cancelled");
    assert.notEqual(stored.rendered, "too late\n");
  });
});

test("claimJobTerminal: late cancel does not clobber completed", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-cas-2";
    const running = {
      id: jobId,
      status: "running",
      phase: "running",
      title: "CAS2",
      bridgePid: 11,
      agentPid: 22,
      pid: 11
    };
    writeJobFile(workspace, jobId, running);
    upsertJob(workspace, running);

    const complete = claimJobTerminal(workspace, jobId, "completed", {
      rendered: "done\n",
      result: { ok: true }
    });
    assert.equal(complete.claimed, true);
    assert.equal(complete.status, "completed");

    const cancel = claimJobTerminal(workspace, jobId, "cancelled", {
      errorMessage: "Stopped by user."
    });
    assert.equal(cancel.claimed, false);
    assert.equal(cancel.status, "completed");
    assert.equal(cancel.reason, "already-terminal");

    const stored = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(stored.status, "completed");
    assert.equal(stored.rendered, "done\n");
  });
});

test("claimJobTerminal: missing job is not resurrected", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const claim = claimJobTerminal(workspace, "no-such-job", "completed", { rendered: "x" });
    assert.equal(claim.claimed, false);
    assert.equal(claim.reason, "missing");
    assert.equal(fs.existsSync(resolveJobFile(workspace, "no-such-job")), false);
  });
});

test("patchJobIfActive skips terminal jobs and preserves bridgePid when setting agentPid", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-patch-1";
    const running = {
      id: jobId,
      status: "running",
      phase: "starting",
      bridgePid: 5001,
      agentPid: null,
      pid: 5001
    };
    writeJobFile(workspace, jobId, running);
    upsertJob(workspace, running);

    const patched = patchJobIfActive(workspace, jobId, { agentPid: 9001, phase: "running" });
    assert.equal(patched.patched, true);
    assert.equal(patched.job.agentPid, 9001);
    assert.equal(patched.job.bridgePid, 5001);
    assert.equal(patched.job.pid, 5001);

    claimJobTerminal(workspace, jobId, "completed", { rendered: "ok\n" });
    const afterTerminal = patchJobIfActive(workspace, jobId, { phase: "should-not-apply" });
    assert.equal(afterTerminal.patched, false);
    assert.equal(afterTerminal.reason, "terminal");
    const stored = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(stored.phase, "done");
  });
});

test("resolveJobKillTargets returns distinct agent and bridge pids, including legacy companionPid", () => {
  assert.deepEqual(
    resolveJobKillTargets({ agentPid: 2, bridgePid: 1, pid: 1 }).sort((a, b) => a - b),
    [1, 2]
  );
  assert.deepEqual(
    resolveJobKillTargets({ agentPid: 2, companionPid: 1, pid: 1 }).sort((a, b) => a - b),
    [1, 2]
  );
  assert.deepEqual(resolveJobKillTargets({ pid: 9 }), [9]);
  assert.deepEqual(resolveJobKillTargets({}), []);
});

test("stop claim-before-kill ordering: claim cancelled then kill targets from pre-claim pids", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-claim-kill-order";
    const running = {
      id: jobId,
      status: "running",
      phase: "running",
      title: "Order",
      bridgePid: 7001,
      agentPid: 7002,
      pid: 7001
    };
    writeJobFile(workspace, jobId, running);
    upsertJob(workspace, running);

    // Capture targets before claim (as handleCancel does).
    const preClaimTargets = resolveJobKillTargets(running);
    assert.deepEqual(preClaimTargets.sort((a, b) => a - b), [7001, 7002]);

    const claim = claimJobTerminal(workspace, jobId, "cancelled", {
      errorMessage: "Stopped by user.",
      pid: null,
      agentPid: null,
      bridgePid: null
    });
    assert.equal(claim.claimed, true);
    assert.equal(claim.status, "cancelled");

    // After claim, stored record has null pids — kill must use pre-claim snapshot.
    const stored = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(stored.agentPid, null);
    assert.equal(stored.bridgePid, null);
    assert.deepEqual(resolveJobKillTargets(stored), []);
    assert.deepEqual(preClaimTargets.sort((a, b) => a - b), [7001, 7002]);

    // Late completed must not win after claim.
    const late = claimJobTerminal(workspace, jobId, "completed", { rendered: "nope\n" });
    assert.equal(late.claimed, false);
    assert.equal(late.reason, "cancelled-wins");
  });
});

// Regression tests for #3: `stop` must not signal a job's pre-claim pids
// unless it actually won the cancel claim.
//
// The bug report's exact TOCTOU window -- the target job finishing on its
// own between handleCancel's initial (unlocked) resolveCancelableJob read
// and its claimJobTerminal call -- happens across two real OS processes and
// can't be landed deterministically from a single-process test.
//
// listJobs() (which resolveCancelableJob uses to find "active" jobs) reads
// only the aggregate state index, while claimJobTerminal() prefers the
// per-job file over the index (readJobFileIfPresent(...) ?? indexJob). A job
// whose file has already been updated to a terminal status but whose index
// entry hasn't caught up yet is exactly the state two racing writers would
// leave behind mid-update -- and it's fully deterministic to construct
// directly, without timing. These call the real, now-exported handleCancel()
// against a real child process, so the actual kill call (or its absence) is
// what's observed, not a re-implementation of its branching.
test("stop does not signal a job's process when the cancel claim is lost", async () => {
  await withPluginDataAsync(async () => {
    const workspace = makeTempDir();
    const jobId = "job-claim-lost-no-kill";
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
      detached: true
    });
    child.unref();
    try {
      await waitFor(() => isAlive(child.pid));

      const running = {
        id: jobId,
        status: "running",
        phase: "running",
        title: "Claim lost",
        bridgePid: child.pid,
        agentPid: child.pid,
        pid: child.pid
      };
      // Index says "running" (what resolveCancelableJob sees)...
      upsertJob(workspace, running);
      // ...but the file already moved to "completed" (what claimJobTerminal
      // prefers), simulating the job finishing just ahead of `stop`.
      writeJobFile(workspace, jobId, { ...running, status: "completed", phase: "completed" });

      await handleCancel([jobId, "--cwd", workspace, "--json"]);

      const stored = readJobFile(resolveJobFile(workspace, jobId));
      assert.equal(stored.status, "completed");
      // terminateProcessTree has an internal ~200ms SIGTERM grace period
      // before it would escalate to SIGKILL, so an immediate isAlive() check
      // would pass whether or not a kill was even attempted. Wait past that
      // window to actually observe the outcome.
      await new Promise((resolve) => setTimeout(resolve, 500));
      assert.equal(isAlive(child.pid), true);
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
    }
  });
});

test("stop does signal a job's process when the cancel claim is won", async () => {
  await withPluginDataAsync(async () => {
    const workspace = makeTempDir();
    const jobId = "job-claim-won-kill";
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore",
      detached: true
    });
    child.unref();
    try {
      await waitFor(() => isAlive(child.pid));

      const running = {
        id: jobId,
        status: "running",
        phase: "running",
        title: "Claim won",
        bridgePid: child.pid,
        agentPid: child.pid,
        pid: child.pid
      };
      writeJobFile(workspace, jobId, running);
      upsertJob(workspace, running);

      await handleCancel([jobId, "--cwd", workspace, "--json"]);

      const stored = readJobFile(resolveJobFile(workspace, jobId));
      assert.equal(stored.status, "cancelled");
      const died = await waitFor(() => !isAlive(child.pid));
      assert.equal(died, true);
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        try {
          process.kill(child.pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
    }
  });
});

function withPluginDataAsync(fn) {
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = makeTempDir();
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous == null) {
        delete process.env.CLAUDE_PLUGIN_DATA;
      } else {
        process.env.CLAUDE_PLUGIN_DATA = previous;
      }
    });
}

test("patchJobIfActive does not resurrect terminal jobs when patching worker pid", () => {
  withPluginData(() => {
    const workspace = makeTempDir();
    const jobId = "job-enqueue-pid";
    const running = {
      id: jobId,
      status: "queued",
      phase: "queued",
      bridgePid: null,
      agentPid: null,
      pid: null
    };
    writeJobFile(workspace, jobId, running);
    upsertJob(workspace, running);

    claimJobTerminal(workspace, jobId, "cancelled", { errorMessage: "stop" });
    const patched = patchJobIfActive(workspace, jobId, {
      bridgePid: 4242,
      pid: 4242,
      status: "queued"
    });
    assert.equal(patched.patched, false);
    assert.equal(patched.reason, "terminal");
    const stored = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(stored.status, "cancelled");
    assert.notEqual(stored.bridgePid, 4242);
  });
});
