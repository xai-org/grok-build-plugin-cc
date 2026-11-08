import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSingleJobSnapshot, buildStatusSnapshot, resolveResultJob } from "../plugins/grok-build/scripts/lib/job-control.mjs";
import {
  claimJobTerminal, loadState, readJobFile, reconcileJobs, resolveJobFile,
  resolveStateFile, resolveStateDir, upsertJob, writeJobFile
} from "../plugins/grok-build/scripts/lib/state.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-job-recovery-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const previousSession = process.env.GROK_CC_SESSION_ID;
  process.env.CLAUDE_PLUGIN_DATA = path.join(root, "state");
  delete process.env.GROK_CC_SESSION_ID;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
    if (previousSession === undefined) delete process.env.GROK_CC_SESSION_ID;
    else process.env.GROK_CC_SESSION_ID = previousSession;
    fs.rmSync(root, { recursive: true, force: true });
  });
  function seed(id, patch = {}) {
    const job = { id, status: "running", phase: "running", bridgePid: 101, agentPid: 102, ...patch };
    writeJobFile(workspace, id, job);
    upsertJob(workspace, job);
    return job;
  }
  return { workspace, seed };
}

test("recovery protects a live bridge, live agent, reused PID and uncertain liveness", (t) => {
  const { workspace, seed } = fixture(t);
  for (const [id, probe] of [
    ["live-bridge", (pid) => pid === 101],
    ["live-agent", (pid) => pid === 102],
    ["reused-pid", () => true],
    ["indeterminate", () => null],
    ["probe-error", () => { throw new Error("cannot inspect process"); }]
  ]) {
    seed(id);
    const before = fs.readFileSync(resolveJobFile(workspace, id), "utf8");
    reconcileJobs(workspace, [id], { isAliveImpl: probe });
    assert.equal(fs.readFileSync(resolveJobFile(workspace, id), "utf8"), before);
    assert.equal(loadState(workspace).jobs.find((job) => job.id === id).status, "running");
  }
});

test("recovery preserves the intervals before worker and agent PID publication", (t) => {
  const { workspace, seed } = fixture(t);
  for (const [id, patch] of [
    ["queued-no-pids", { status: "queued", bridgePid: null, agentPid: null }],
    ["queued-worker", { status: "queued", bridgePid: 101, agentPid: null }],
    ["agent-spawn-window", { bridgePid: 101, agentPid: null }],
    ["missing-bridge", { bridgePid: null, agentPid: 102 }],
    ["malformed-pid", { bridgePid: -1, agentPid: 102 }]
  ]) {
    const job = seed(id, patch);
    reconcileJobs(workspace, [id], { isAliveImpl: () => assert.fail("incomplete process ownership must stay protected") });
    assert.deepEqual(readJobFile(resolveJobFile(workspace, id)), job);
  }
});

test("recovery reads current file PIDs and repairs an interrupted active index update", (t) => {
  const { workspace, seed } = fixture(t);
  const job = seed("fresh-file", { agentPid: null });
  writeJobFile(workspace, job.id, { ...job, agentPid: 103, phase: "investigating" });
  const probes = [];
  reconcileJobs(workspace, [job.id], { isAliveImpl: (pid) => { probes.push(pid); return pid === 103; } });
  assert.deepEqual(probes, [101, 103]);
  const indexed = loadState(workspace).jobs[0];
  assert.equal(indexed.status, "running");
  assert.equal(indexed.agentPid, 103);
  assert.equal(indexed.phase, "investigating");
});

test("terminal recovery preserves results and repeated reads do not rewrite history", (t) => {
  const { workspace, seed } = fixture(t);
  for (const status of ["completed", "failed", "cancelled"]) {
    const job = seed(status);
    const saved = { ...job, status, phase: status, pid: null, agentPid: null,
      completedAt: "2026-01-01T00:00:00.000Z", result: { detail: status }, rendered: `${status}\n` };
    writeJobFile(workspace, job.id, saved);
    reconcileJobs(workspace, [job.id], { isAliveImpl: () => assert.fail("terminal results need no liveness probe") });
    assert.deepEqual(readJobFile(resolveJobFile(workspace, job.id)), saved);
    assert.equal(loadState(workspace).jobs.find((entry) => entry.id === job.id).status, status);
  }
  const before = fs.readFileSync(resolveStateFile(workspace), "utf8");
  reconcileJobs(workspace, ["completed", "failed", "cancelled"]);
  assert.equal(fs.readFileSync(resolveStateFile(workspace), "utf8"), before);
});

test("dead recovery uses terminal claims and retains logs, session and result metadata", (t) => {
  const { workspace, seed } = fixture(t);
  const logFile = path.join(workspace, "run.log");
  fs.writeFileSync(logFile, "partial output\n");
  const job = seed("dead", { sessionId: "session-a", threadId: "thread-a", logFile, result: { partial: true } });
  reconcileJobs(workspace, [job.id], { isAliveImpl: () => false });
  const recovered = readJobFile(resolveJobFile(workspace, job.id));
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.sessionId, "session-a");
  assert.equal(recovered.threadId, "thread-a");
  assert.deepEqual(recovered.result, { partial: true });
  assert.ok(recovered.completedAt);
  assert.equal(fs.readFileSync(logFile, "utf8"), "partial output\n");
  const late = claimJobTerminal(workspace, job.id, "completed", { rendered: "late completion" });
  assert.equal(late.claimed, false);
  assert.equal(late.status, "failed");
  assert.deepEqual(readJobFile(resolveJobFile(workspace, job.id)), recovered);
});

test("status reconciles only the requested session, and an explicit reference can recover another", (t) => {
  const { workspace, seed } = fixture(t);
  // Session routing needs stable dead-owner evidence. A real exited PID can
  // be reused while the fixture writes its jobs. Native death and live-orphan
  // behavior are exercised separately by crash-recovery.test.mjs.
  const pids = { bridgePid: process.pid + 1, agentPid: process.pid + 2 };
  const kill = process.kill.bind(process);
  t.mock.method(process, "kill", (pid, signal) => {
    if (signal === 0 && [pids.bridgePid, pids.agentPid].includes(pid)) {
      throw Object.assign(new Error("fixture owner has exited"), { code: "ESRCH" });
    }
    return kill(pid, signal);
  });
  seed("session-a-job", { ...pids, sessionId: "session-a" });
  seed("session-b-job", { ...pids, sessionId: "session-b" });
  const otherBefore = fs.readFileSync(resolveJobFile(workspace, "session-b-job"), "utf8");
  const report = buildStatusSnapshot(workspace, { sessionId: "session-a" });
  assert.equal(report.running.length, 0);
  assert.equal(report.latestFinished.id, "session-a-job");
  assert.equal(fs.readFileSync(resolveJobFile(workspace, "session-b-job"), "utf8"), otherBefore);
  assert.equal(loadState(workspace).jobs.find((job) => job.id === "session-b-job").status, "running");
  const single = buildSingleJobSnapshot(workspace, "session-b-job");
  assert.equal(single.job.status, "failed");
  assert.equal(resolveResultJob(workspace, "session-b-job").job.status, "failed");
});

test("recovery does not resurrect a missing job", (t) => {
  const { workspace } = fixture(t);
  assert.deepEqual(reconcileJobs(workspace, ["missing"]), []);
  assert.equal(fs.existsSync(resolveJobFile(workspace, "missing")), false);
});

test("an unchanged completed status remains readable while an unrelated writer holds the lock", (t) => {
  const { workspace, seed } = fixture(t);
  seed("finished");
  claimJobTerminal(workspace, "finished", "completed", { rendered: "done\n" });
  const lock = path.join(resolveStateDir(workspace), "state.json.lock");
  fs.writeFileSync(lock, "");
  assert.equal(buildStatusSnapshot(workspace).latestFinished.status, "completed");
  assert.equal(fs.readFileSync(lock, "utf8"), "");
});

test("reconciliation surfaces corrupt job files and permission failures", (t) => {
  const { workspace, seed } = fixture(t);
  const job = seed("unreadable");
  const file = resolveJobFile(workspace, job.id);
  const indexBefore = fs.readFileSync(resolveStateFile(workspace), "utf8");
  fs.writeFileSync(file, "{corrupt");
  assert.throws(() => buildStatusSnapshot(workspace), SyntaxError);
  assert.equal(fs.readFileSync(file, "utf8"), "{corrupt");
  writeJobFile(workspace, job.id, job);
  const read = fs.readFileSync;
  const mocked = t.mock.method(fs, "readFileSync", (target, ...args) => {
    if (target === file) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return read(target, ...args);
  });
  try {
    assert.throws(() => buildStatusSnapshot(workspace), { code: "EACCES" });
  } finally {
    mocked.mock.restore();
  }
  assert.deepEqual(readJobFile(file), job);
  assert.equal(fs.readFileSync(resolveStateFile(workspace), "utf8"), indexBefore);
});
