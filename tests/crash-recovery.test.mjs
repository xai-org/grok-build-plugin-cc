import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadState, patchJobIfActive, readJobFile, resolveJobFile, resolveStateDir, updateState, upsertJob, withStateLock, writeJobFile } from "../plugins/grok-build/scripts/lib/state.mjs";

const SCRIPT = fileURLToPath(new URL("../plugins/grok-build/scripts/grok-bridge.mjs", import.meta.url));
const WORKER = fileURLToPath(new URL("./recovery-worker.mjs", import.meta.url));

async function waitFor(read, description) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function readReady(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "grok-crash-test-"));
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace);
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  const previousSession = process.env.GROK_CC_SESSION_ID;
  process.env.CLAUDE_PLUGIN_DATA = path.join(root, "plugin-data");
  delete process.env.GROK_CC_SESSION_ID;
  const env = { ...process.env };
  const children = [];
  const detachedPids = new Set();
  t.after(async () => {
    for (const pid of detachedPids) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    await Promise.all(children.map((child) => child.closed));
    if (previous === undefined) delete process.env.CLAUDE_PLUGIN_DATA;
    else process.env.CLAUDE_PLUGIN_DATA = previous;
    if (previousSession === undefined) delete process.env.GROK_CC_SESSION_ID;
    else process.env.GROK_CC_SESSION_ID = previousSession;
    fs.rmSync(root, { recursive: true, force: true });
  });
  function worker(mode, name) {
    const ready = path.join(root, `${name}.ready`);
    const release = path.join(root, `${name}.release`);
    const child = spawn(process.execPath, [WORKER, mode, workspace, ready, release], {
      env, stdio: ["ignore", "pipe", "pipe"]
    });
    child.errors = "";
    child.stderr.on("data", (data) => { child.errors += data; });
    child.closed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    children.push(child);
    return { child, ready, release };
  }
  function cli(...args) {
    const started = Date.now();
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: workspace, env, encoding: "utf8", timeout: args[0] === "run" ? 30000 : 10000
    });
    result.elapsedMs = Date.now() - started;
    return result;
  }
  return { root, workspace, env, worker, cli, detachedPids };
}

test("a killed lock holder does not block the next state transaction", async (t) => {
  const fixture = setup(t);
  const owner = fixture.worker("hold", "owner");
  await waitFor(() => readReady(owner.ready), "actual lock acquisition");
  owner.child.kill("SIGKILL");
  await owner.child.closed;
  assert.equal(fs.existsSync(path.join(resolveStateDir(fixture.workspace), "state.json.lock")), true);
  let entered = false;
  withStateLock(fixture.workspace, () => { entered = true; });
  assert.equal(entered, true);
});

test("two contenders recover a killed owner without overlapping or losing updates", async (t) => {
  const fixture = setup(t);
  const owner = fixture.worker("hold", "owner");
  await waitFor(() => readReady(owner.ready), "actual lock acquisition");
  owner.child.kill("SIGKILL");
  await owner.child.closed;
  const contenders = [fixture.worker("increment", "first"), fixture.worker("increment", "second")];
  for (const { child } of contenders) assert.equal(await child.closed, 0, child.errors);
  assert.equal(loadState(fixture.workspace).config.counter, 16);
  assert.equal(fs.existsSync(path.join(fixture.workspace, "critical-section")), false);
});

test("runs reconciles a killed background fake Grok run and preserves its log", async (t) => {
  const fixture = setup(t);
  const fakeReady = path.join(fixture.root, "fake-ready.json");
  const fakeRelease = path.join(fixture.root, "fake-release");
  const fakeScript = path.join(fixture.root, "fake-grok.mjs");
  fs.writeFileSync(fakeScript, `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args.includes("version") || args.includes("--version")) {
  console.log(JSON.stringify({ currentVersion: "0.2.83-fake" }));
} else if (args[0] === "models") {
  console.log("You are logged in with grok.com.");
} else {
  fs.writeFileSync(${JSON.stringify(fakeReady)}, JSON.stringify({pid: process.pid}));
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(${JSON.stringify(fakeRelease)})) {
    if (Date.now() > deadline) process.exit(2);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  const answer = "Finished fake work.";
  // Like the real CLI: streaming-messages-json is NDJSON ending in a result event.
  const format = args[args.indexOf("--output-format") + 1];
  console.log(format === "streaming-messages-json"
    ? [{ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: answer }] } },
       { type: "result", subtype: "success", is_error: false, result: answer }].map((e) => JSON.stringify(e)).join("\\n")
    : answer);
}
`, { mode: 0o755 });
  fixture.env.GROK_BINARY = fakeScript;
  if (process.platform === "win32") {
    // Teach only this fixture how to launch its JavaScript fake executable.
    // Detach the fake agent so Windows keeps it alive when its bridge exits.
    // Native children still provide the PIDs, signals and handshakes; production
    // .cmd/PATH support is a separate Windows integration concern.
    const preload = path.join(fixture.root, "launch-fake.mjs");
    fs.writeFileSync(preload, `
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
for (const method of ["spawn", "spawnSync"]) {
  const original = childProcess[method];
  childProcess[method] = (binary, args, options) => binary === ${JSON.stringify(fakeScript)}
    ? original(process.execPath, [binary, ...args], { ...options, shell: false, detached: method === "spawn" })
    : original(binary, args, options);
}
syncBuiltinESMExports();
`);
    fixture.env.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
  }
  const launched = fixture.cli("run", "--background", "--json", "local crash recovery fixture");
  assert.equal(launched.status, 0, launched.stderr);
  const { jobId, bridgePid } = JSON.parse(launched.stdout);
  fixture.detachedPids.add(bridgePid);
  const agent = await waitFor(() => readReady(fakeReady), "fake Grok startup");
  fixture.detachedPids.add(agent.pid);
  const stored = await waitFor(() => {
    const job = readJobFile(resolveJobFile(fixture.workspace, jobId));
    return job.agentPid === agent.pid && job.status === "running" ? job : null;
  }, "publication of both process IDs");
  const log = fs.readFileSync(stored.logFile, "utf8");
  assert.ok(log.length > 0);
  process.kill(bridgePid, "SIGKILL");
  fixture.detachedPids.delete(bridgePid);
  const orphanedAgent = fixture.cli("runs", "--json");
  assert.equal(orphanedAgent.status, 0, orphanedAgent.stderr);
  assert.equal(JSON.parse(orphanedAgent.stdout).running[0].id, jobId);
  assert.doesNotThrow(() => process.kill(agent.pid, 0), "the fake agent stays alive after its bridge exits");
  process.kill(agent.pid, "SIGKILL");
  fixture.detachedPids.delete(agent.pid);
  // Wait for the actual CLI observation to reach a terminal result, allowing OS reaping.
  let status;
  await waitFor(() => {
    const result = fixture.cli("runs", "--json");
    assert.equal(result.status, 0, result.stderr);
    status = JSON.parse(result.stdout);
    return status.running.length === 0;
  }, "dead run reconciliation");
  assert.equal(status.latestFinished.id, jobId);
  assert.equal(status.latestFinished.status, "failed");
  assert.match(status.latestFinished.errorMessage, /process|exit|interrupt/i);
  const recovered = readJobFile(resolveJobFile(fixture.workspace, jobId));
  assert.equal(recovered.status, "failed");
  assert.equal(recovered.status, loadState(fixture.workspace).jobs[0].status);
  assert.equal(fs.readFileSync(stored.logFile, "utf8"), log);
  const recoveredFile = fs.readFileSync(resolveJobFile(fixture.workspace, jobId), "utf8");
  for (let index = 0; index < 3; index += 1) {
    assert.equal(fixture.cli("runs", jobId, "--wait", "--json").status, 0);
    assert.equal(fs.readFileSync(resolveJobFile(fixture.workspace, jobId), "utf8"), recoveredFile);
  }
  fs.writeFileSync(fakeRelease, "release");
  assert.ok(recovered.threadId, "interrupted session remains resumable");
  const next = fixture.cli("run", "--resume-last", "--json");
  assert.equal(next.status, 0, next.error?.message || next.stderr);
  t.diagnostic(`resume completed in ${next.elapsedMs} ms`);
  const fresh = fixture.cli("run", "--fresh", "--json", "another local fake task");
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(fixture.cli("show", jobId, "--json").status, 0);
});

test("an old timestamp cannot authorize stealing a live owner's lock", async (t) => {
  const fixture = setup(t);
  const owner = fixture.worker("hold", "owner");
  await waitFor(() => readReady(owner.ready), "live owner");
  const lock = path.join(resolveStateDir(fixture.workspace), "state.json.lock");
  const marker = fs.readdirSync(lock)[0];
  const metadata = fs.readFileSync(path.join(lock, marker), "utf8");
  fs.utimesSync(lock, new Date(0), new Date(0));
  let entered = false;
  assert.throws(() => withStateLock(fixture.workspace, () => { entered = true; }), /Owner process .* still present/);
  assert.equal(entered, false);
  assert.equal(fs.readFileSync(path.join(lock, marker), "utf8"), metadata);
  assert.equal(owner.child.exitCode, null);
  fs.writeFileSync(owner.release, "release");
  assert.equal(await owner.child.closed, 0, owner.child.errors);
  withStateLock(fixture.workspace, () => {});
});

test("callback errors release ownership and clean unpublished candidates", (t) => {
  const { workspace } = setup(t);
  assert.throws(() => withStateLock(workspace, () => { throw new Error("callback failed"); }), /callback failed/);
  withStateLock(workspace, () => {});
  assert.equal(fs.readdirSync(resolveStateDir(workspace)).some((name) => name.startsWith("state.json.lock")), false);
});

test("malformed, foreign-host and reused-PID lock owners stay protected", async (t) => {
  const fixture = setup(t);
  const owner = fixture.worker("hold", "owner");
  await waitFor(() => readReady(owner.ready), "owner publication");
  owner.child.kill("SIGKILL");
  await owner.child.closed;
  const lock = path.join(resolveStateDir(fixture.workspace), "state.json.lock");
  const marker = path.join(lock, fs.readdirSync(lock)[0]);
  const original = JSON.parse(fs.readFileSync(marker, "utf8"));
  for (const content of ["{partial", JSON.stringify({ ...original, hostname: `${os.hostname()}-other` }),
    JSON.stringify({ ...original, pid: process.pid })]) {
    fs.writeFileSync(marker, content);
    assert.throws(() => withStateLock(fixture.workspace, () => assert.fail("unverified owner stolen")), /Timed out acquiring state lock/);
    assert.equal(fs.readFileSync(marker, "utf8"), content);
  }
});

test("lock recovery preserves permission-denied and indeterminate owners", async (t) => {
  const fixture = setup(t);
  const owner = fixture.worker("hold", "owner");
  await waitFor(() => readReady(owner.ready), "owner publication");
  owner.child.kill("SIGKILL");
  await owner.child.closed;
  const lock = path.join(resolveStateDir(fixture.workspace), "state.json.lock");
  const marker = fs.readdirSync(lock)[0];
  const kill = process.kill.bind(process);
  for (const code of ["EPERM", "EIO"]) {
    const mocked = t.mock.method(process, "kill", (pid, signal) => {
      if (pid === owner.child.pid && signal === 0) throw Object.assign(new Error("probe unavailable"), { code });
      return kill(pid, signal);
    });
    try {
      assert.throws(() => withStateLock(fixture.workspace, () => assert.fail("unverified owner stolen")), /Timed out acquiring state lock/);
      assert.deepEqual(fs.readdirSync(lock), [marker]);
    } finally {
      mocked.mock.restore();
    }
  }
  withStateLock(fixture.workspace, () => {});
});

test("legacy lock files remain intact and have an explicit offline repair diagnostic", (t) => {
  const { workspace } = setup(t);
  const dir = resolveStateDir(workspace);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, "state.json.lock");
  for (const content of ["", "{malformed"]) {
    fs.writeFileSync(lock, content);
    assert.throws(() => withStateLock(workspace, () => assert.fail("legacy lock stolen")), /manual repair.*stop all bridge/);
    assert.equal(fs.readFileSync(lock, "utf8"), content);
    fs.renameSync(lock, `${lock}.saved`);
    withStateLock(workspace, () => {});
    fs.unlinkSync(`${lock}.saved`);
  }
});

test("unreadable lock ownership stays protected and a readable retry can recover", async (t) => {
  const fixture = setup(t);
  const owner = fixture.worker("hold", "owner");
  await waitFor(() => readReady(owner.ready), "lock publication");
  owner.child.kill("SIGKILL");
  await owner.child.closed;
  const lock = path.join(resolveStateDir(fixture.workspace), "state.json.lock");
  const marker = path.join(lock, fs.readdirSync(lock)[0]);
  const metadata = fs.readFileSync(marker, "utf8");
  const read = fs.readFileSync;
  for (const code of ["EPERM", "EACCES"]) {
    const denied = t.mock.method(fs, "readFileSync", (file, ...args) => {
      if (file === marker) throw Object.assign(new Error("owner metadata unavailable"), { code });
      return read(file, ...args);
    });
    try {
      assert.throws(() => withStateLock(fixture.workspace, () => assert.fail("unverified owner removed")),
        new RegExp(`Timed out acquiring state lock.*ownership cannot be verified \\(${code}\\)`));
    } finally {
      denied.mock.restore();
    }
    assert.equal(fs.readFileSync(marker, "utf8"), metadata);
  }
  let attempts = 0;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    if (file === marker && attempts++ === 0) throw Object.assign(new Error("transient read denial"), { code: "EPERM" });
    return read(file, ...args);
  });
  let entered = false;
  withStateLock(fixture.workspace, () => { entered = true; });
  assert.equal(entered, true);
  assert.ok(attempts > 1);
});

test("Windows publication reservations survive a crash and require offline repair", { skip: process.platform !== "win32" }, async (t) => {
  const fixture = setup(t);
  const owner = fixture.worker("after-reservation", "owner");
  await waitFor(() => readReady(owner.ready)?.reserved, "exclusive Windows reservation");
  owner.child.kill("SIGKILL");
  await owner.child.closed;
  const lock = path.join(resolveStateDir(fixture.workspace), "state.json.lock");
  const content = fs.readFileSync(lock, "utf8");
  assert.equal(JSON.parse(content).pid, owner.child.pid);
  assert.throws(() => withStateLock(fixture.workspace, () => assert.fail("reservation stolen")), /manual repair.*stop all bridge/);
  assert.equal(fs.readFileSync(lock, "utf8"), content);
  fs.renameSync(lock, `${lock}.saved`);
  withStateLock(fixture.workspace, () => {});
  fs.unlinkSync(`${lock}.saved`);
});

test("a stale reaper cannot delete the replacement owner's lock", async (t) => {
  const fixture = setup(t);
  const owner = fixture.worker("hold", "owner");
  await waitFor(() => readReady(owner.ready), "original owner");
  owner.child.kill("SIGKILL");
  await owner.child.closed;
  const first = fixture.worker("reap-hold", "first");
  const delayed = fixture.worker("reap-hold", "delayed");
  await waitFor(() => readReady(first.ready)?.beforeReap, "first reaper observation");
  await waitFor(() => readReady(delayed.ready)?.beforeReap, "second reaper observation");
  fs.writeFileSync(`${first.release}.reap`, "release");
  await waitFor(() => fs.existsSync(`${first.ready}.acquired`), "replacement owner");
  const lock = path.join(resolveStateDir(fixture.workspace), "state.json.lock");
  const marker = fs.readdirSync(lock)[0];
  fs.writeFileSync(`${delayed.release}.reap`, "release");
  await waitFor(() => fs.existsSync(`${delayed.ready}.contended`), "delayed reaper's failed acquisition");
  assert.equal(fs.existsSync(`${delayed.ready}.acquired`), false);
  assert.deepEqual(fs.readdirSync(lock), [marker]);
  fs.writeFileSync(`${first.release}.held`, "release");
  assert.equal(await first.child.closed, 0, first.child.errors);
  await waitFor(() => fs.existsSync(`${delayed.ready}.acquired`), "later acquisition after release");
  fs.writeFileSync(`${delayed.release}.held`, "release");
  assert.equal(await delayed.child.closed, 0, delayed.child.errors);
});

for (const mode of ["during-metadata", "before-publication", "after-publication", "empty-retired"]) {
  test(`recovery survives a crash at ${mode}`, async (t) => {
    const fixture = setup(t);
    if (mode === "empty-retired") {
      const owner = fixture.worker("hold", "owner");
      await waitFor(() => readReady(owner.ready), "original owner");
      owner.child.kill("SIGKILL");
      await owner.child.closed;
    }
    const interrupted = fixture.worker(mode, "interrupted");
    await waitFor(() => readReady(interrupted.ready), mode);
    interrupted.child.kill("SIGKILL");
    await interrupted.child.closed;
    if (mode === "before-publication" || mode === "during-metadata") {
      assert.equal(fs.existsSync(path.join(resolveStateDir(fixture.workspace), "state.json.lock")), false);
    }
    withStateLock(fixture.workspace, () => {});
  });
}

test("a crash between terminal job and index writes preserves the completed result", async (t) => {
  const fixture = setup(t);
  const job = { id: "interrupted-write", status: "running", bridgePid: process.pid, agentPid: process.pid };
  writeJobFile(fixture.workspace, job.id, job);
  upsertJob(fixture.workspace, job);
  const writer = fixture.worker("terminal-write", "writer");
  await waitFor(() => readReady(writer.ready), "terminal job write before index write");
  writer.child.kill("SIGKILL");
  await writer.child.closed;
  assert.equal(loadState(fixture.workspace).jobs[0].status, "running");
  const saved = readJobFile(resolveJobFile(fixture.workspace, job.id));
  assert.equal(saved.status, "completed");
  const status = fixture.cli("runs", "--json");
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).latestFinished.status, "completed");
  assert.deepEqual(readJobFile(resolveJobFile(fixture.workspace, job.id)), saved);
  assert.equal(loadState(fixture.workspace).jobs[0].status, "completed");
});

test("recovery rechecks agent ownership published after its initial dead-run observation", async (t) => {
  const fixture = setup(t);
  const exited = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
  assert.equal(exited.status, 0);
  const job = { id: "publication-race", status: "running", bridgePid: exited.pid, agentPid: exited.pid };
  writeJobFile(fixture.workspace, job.id, job);
  upsertJob(fixture.workspace, job);
  const recovery = fixture.worker("reconcile-paused", "recovery");
  await waitFor(() => readReady(recovery.ready), "recovery waiting to acquire after its initial observation");
  patchJobIfActive(fixture.workspace, job.id, { agentPid: process.pid });
  fs.writeFileSync(recovery.release, "release");
  assert.equal(await recovery.child.closed, 0, recovery.child.errors);
  const saved = readJobFile(resolveJobFile(fixture.workspace, job.id));
  assert.equal(saved.status, "running");
  assert.equal(saved.agentPid, process.pid);
  assert.equal(loadState(fixture.workspace).jobs[0].status, "running");
  assert.equal(loadState(fixture.workspace).jobs[0].agentPid, process.pid);
});

test("completion, cancellation and recovery serialize one terminal job and index", async (t) => {
  const fixture = setup(t);
  const owner = fixture.worker("hold", "owner");
  await waitFor(() => readReady(owner.ready), "original owner");
  owner.child.kill("SIGKILL");
  await owner.child.closed;
  const logFile = path.join(fixture.root, "retained.log");
  fs.writeFileSync(logFile, "Existing diagnostic output.\n");
  const job = { id: "race-job", status: "running", bridgePid: owner.child.pid, agentPid: owner.child.pid, logFile };
  writeJobFile(fixture.workspace, job.id, job);
  upsertJob(fixture.workspace, job);
  const writers = ["completed", "cancelled", "recovery"].map((status) => fixture.worker(`race-${status}`, status));
  for (const writer of writers) await waitFor(() => readReady(writer.ready), "terminal contender startup");
  for (const writer of writers) fs.writeFileSync(writer.release, "release");
  for (const writer of writers) assert.equal(await writer.child.closed, 0, writer.child.errors);
  const saved = readJobFile(resolveJobFile(fixture.workspace, job.id));
  assert.ok(["completed", "cancelled", "failed"].includes(saved.status));
  const indexed = loadState(fixture.workspace).jobs[0];
  assert.equal(indexed.status, saved.status);
  assert.equal(indexed.phase, saved.phase);
  assert.equal(indexed.completedAt, saved.completedAt);
  assert.equal(fs.readFileSync(logFile, "utf8"), "Existing diagnostic output.\n");
});

test("status tolerates a job pruned during its optimistic file read", async (t) => {
  const fixture = setup(t);
  const exited = spawnSync(process.execPath, ["-e", ""], { timeout: 5000 });
  assert.equal(exited.status, 0);
  const job = { id: "pruned-run", status: "running", bridgePid: exited.pid, agentPid: exited.pid };
  writeJobFile(fixture.workspace, job.id, job);
  upsertJob(fixture.workspace, job);
  const reader = fixture.worker("status-pruned", "reader");
  await waitFor(() => readReady(reader.ready), "status waiting to read the job file");
  updateState(fixture.workspace, (state) => { state.jobs = []; });
  fs.writeFileSync(reader.release, "release");
  assert.equal(await reader.child.closed, 0, reader.child.errors);
  const status = readReady(`${reader.ready}.status`);
  assert.deepEqual(status.running, []);
  assert.equal(status.latestFinished, null);
  assert.deepEqual(loadState(fixture.workspace).jobs, []);
  assert.equal(fs.existsSync(resolveJobFile(fixture.workspace, job.id)), false);
});
