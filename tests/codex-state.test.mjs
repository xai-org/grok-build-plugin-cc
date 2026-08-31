import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir } from "./helpers.mjs";
import {
  claimJobTerminal,
  loadState,
  patchJobIfActive,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  saveState,
  upsertJob,
  writeJobFile
} from "../codex/plugins/grok-build/scripts/lib/state.mjs";
import { resolveJobKillTargets } from "../codex/plugins/grok-build/scripts/lib/tracked-jobs.mjs";

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

test("Codex state defaults below ~/.codex/grok-build/state", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace, {});
  assert.equal(stateDir.startsWith(path.join(os.homedir(), ".codex", "grok-build", "state")), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
});

test("GROK_CODEX_DATA overrides the Codex data root", () => {
  const workspace = makeTempDir();
  const dataRoot = makeTempDir();
  const stateDir = resolveStateDir(workspace, { GROK_CODEX_DATA: dataRoot });
  assert.equal(stateDir.startsWith(path.join(dataRoot, "state")), true);
});

test("saveState prunes dropped job artifacts when indexed jobs exceed the cap", () => {
  withCodexData(() => {
    const workspace = makeTempDir();
    const stateFile = resolveStateFile(workspace);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });

    const jobs = Array.from({ length: 51 }, (_, index) => {
      const jobId = `job-${index}`;
      const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
      const logFile = resolveJobLogFile(workspace, jobId);
      const jobFile = resolveJobFile(workspace, jobId);
      fs.writeFileSync(logFile, `log ${jobId}\n`, "utf8");
      fs.writeFileSync(jobFile, JSON.stringify({ id: jobId, status: "completed" }, null, 2), "utf8");
      return {
        id: jobId,
        status: "completed",
        logFile,
        updatedAt,
        createdAt: updatedAt
      };
    });

    fs.writeFileSync(
      stateFile,
      `${JSON.stringify(
        {
          version: 1,
          config: {},
          jobs
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    saveState(workspace, {
      version: 1,
      config: {},
      jobs
    });

    const prunedJobFile = resolveJobFile(workspace, "job-0");
    const retainedJobFile = resolveJobFile(workspace, "job-50");
    const retainedLogFile = resolveJobLogFile(workspace, "job-50");
    const jobsDir = path.dirname(prunedJobFile);

    assert.equal(fs.existsSync(retainedJobFile), true);
    assert.equal(fs.existsSync(retainedLogFile), true);

    const savedState = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    assert.equal(savedState.jobs.length, 50);
    assert.deepEqual(
      savedState.jobs.map((job) => job.id),
      Array.from({ length: 50 }, (_, index) => `job-${50 - index}`)
    );
    assert.deepEqual(
      fs.readdirSync(jobsDir).sort(),
      Array.from({ length: 50 }, (_, index) => `job-${index + 1}`)
        .flatMap((jobId) => [`${jobId}.json`, `${jobId}.log`])
        .sort()
    );
  });
});

test("loadState quarantines corrupt state and throws instead of wiping", () => {
  withCodexData(() => {
    const workspace = makeTempDir();
    const stateFile = resolveStateFile(workspace);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true });
    fs.writeFileSync(stateFile, "{not-json", "utf8");

    assert.throws(() => loadState(workspace), /corrupt|quarantined/i);

    const dirEntries = fs.readdirSync(path.dirname(stateFile));
    assert.ok(dirEntries.some((name) => name.startsWith("state.json.corrupt-")));
    assert.equal(fs.existsSync(stateFile), false);
  });
});

test("loadState returns default state when the file is missing", () => {
  withCodexData(() => {
    const workspace = makeTempDir();
    const state = loadState(workspace);
    assert.equal(state.version, 1);
    assert.deepEqual(state.jobs, []);
    assert.deepEqual(state.config, {});
  });
});

test("claimJobTerminal: cancelled wins over completed", () => {
  withCodexData(() => {
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
  withCodexData(() => {
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
  withCodexData(() => {
    const workspace = makeTempDir();
    const claim = claimJobTerminal(workspace, "no-such-job", "completed", { rendered: "x" });
    assert.equal(claim.claimed, false);
    assert.equal(claim.reason, "missing");
    assert.equal(fs.existsSync(resolveJobFile(workspace, "no-such-job")), false);
  });
});

test("patchJobIfActive skips terminal jobs and preserves bridgePid when setting agentPid", () => {
  withCodexData(() => {
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
  withCodexData(() => {
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

    const stored = readJobFile(resolveJobFile(workspace, jobId));
    assert.equal(stored.agentPid, null);
    assert.equal(stored.bridgePid, null);
    assert.deepEqual(resolveJobKillTargets(stored), []);
    assert.deepEqual(preClaimTargets.sort((a, b) => a - b), [7001, 7002]);

    const late = claimJobTerminal(workspace, jobId, "completed", { rendered: "nope\n" });
    assert.equal(late.claimed, false);
    assert.equal(late.reason, "cancelled-wins");
  });
});

function assertOmitsSessionId(job, label) {
  assert.equal(Object.hasOwn(job, "sessionId"), false, label);
}

test("Codex job records omit sessionId through create, patch, and terminal transitions", () => {
  withCodexData(() => {
    const workspace = makeTempDir();

    for (const nextStatus of ["completed", "failed", "cancelled"]) {
      const jobId = `job-session-${nextStatus}`;
      const running = {
        id: jobId,
        status: "running",
        phase: "running",
        title: nextStatus,
        sessionId: "legacy-claude-session",
        threadId: `thread-${nextStatus}`,
        bridgePid: 11,
        agentPid: 22,
        pid: 11
      };
      writeJobFile(workspace, jobId, running);
      upsertJob(workspace, running);

      assertOmitsSessionId(readJobFile(resolveJobFile(workspace, jobId)), `${nextStatus} stored after write`);
      assertOmitsSessionId(
        loadState(workspace).jobs.find((job) => job.id === jobId),
        `${nextStatus} index after upsert`
      );

      const patched = patchJobIfActive(workspace, jobId, {
        phase: "investigating",
        sessionId: "should-not-persist"
      });
      assert.equal(patched.patched, true);
      assertOmitsSessionId(patched.job, `${nextStatus} patched in-memory`);
      assert.equal(patched.job.threadId, `thread-${nextStatus}`);

      const claimed = claimJobTerminal(workspace, jobId, nextStatus, {
        threadId: `thread-${nextStatus}`,
        sessionId: "still-should-not-persist",
        rendered: `${nextStatus}\n`
      });
      assert.equal(claimed.claimed, true);
      assert.equal(claimed.status, nextStatus);
      assertOmitsSessionId(claimed.job, `${nextStatus} claimed in-memory`);
      assert.equal(claimed.job.threadId, `thread-${nextStatus}`);
      assertOmitsSessionId(readJobFile(resolveJobFile(workspace, jobId)), `${nextStatus} stored after claim`);
      const indexed = loadState(workspace).jobs.find((job) => job.id === jobId);
      assertOmitsSessionId(indexed, `${nextStatus} index after claim`);
      assert.equal(indexed.threadId, `thread-${nextStatus}`);
    }
  });
});

test("patchJobIfActive does not resurrect terminal jobs when patching worker pid", () => {
  withCodexData(() => {
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
