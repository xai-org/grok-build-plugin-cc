import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeGrok } from "./fake-grok-fixture.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";
import {
  generateJobId,
  listJobs,
  resolveStateDir,
  upsertJob,
  writeJobFile
} from "../codex/plugins/grok-build/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "codex", "plugins", "grok-build", "scripts", "grok-bridge.mjs");

function pluginDataEnv(pluginDataDir, binDir, extra = {}) {
  return buildEnv(binDir, {
    GROK_CODEX_DATA: pluginDataDir,
    ...extra
  });
}

function withCodexData(pluginDataDir, fn) {
  const previous = process.env.GROK_CODEX_DATA;
  process.env.GROK_CODEX_DATA = pluginDataDir;
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

function lastFakeGrokArgv(logPath) {
  const lines = fs
    .readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const printRun = [...lines].reverse().find((entry) => entry.argv?.includes("-p"));
  assert.ok(printRun, "expected a headless grok -p invocation");
  return printRun.argv;
}

function setupReviewableRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeGrokLog = path.join(pluginDataDir, "fake-grok.log");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 1;\n");
  run("git", ["add", "src.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src.js"), "export const value = 2;\n");
  return { repo, binDir, pluginDataDir, fakeGrokLog };
}

function setupCommittedRepo() {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeGrokLog = path.join(pluginDataDir, "fake-grok.log");
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  return { repo, binDir, pluginDataDir, fakeGrokLog };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code !== "ESRCH";
  }
  const ps = run("ps", ["-p", String(pid), "-o", "stat="]);
  const stat = String(ps.stdout ?? "").trim().toUpperCase();
  if (!stat || stat.includes("Z")) {
    return false;
  }
  return true;
}

test("Codex check reports ready and plugin-owned runtime", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);

  const result = run("node", [SCRIPT, "check", "--json"], {
    cwd: ROOT,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.sessionRuntime.mode, "plugin-owned");
  assert.match(payload.sessionRuntime.detail, /Codex plugin/);
});

test("Codex check retains non-fatal grok models stderr", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);

  const result = run("node", [SCRIPT, "check", "--json"], {
    cwd: ROOT,
    env: pluginDataEnv(pluginDataDir, binDir, {
      FAKE_GROK_MODELS_STDERR: "warning: models catalog is stale\n"
    })
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.match(payload.auth.detail, /You are logged in with grok\.com/);
  assert.match(payload.auth.detail, /warning: models catalog is stale/);
});

test("Codex bridge rejects Claude transcript import", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  const env = pluginDataEnv(pluginDataDir, binDir);

  const result = run("node", [SCRIPT, "import"], { cwd: ROOT, env });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /Unknown command: import/);
});

test("review renders a no-findings style result from fake grok", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepo();

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reviewed uncommitted changes|No material issues found/i);
  assert.match(result.stdout, /Grok Build Review|Target:/);
});

test("review forwards --model and --effort to grok", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupReviewableRepo();

  const result = run(
    "node",
    [SCRIPT, "review", "--model", "grok-build", "--effort", "high"],
    {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir, { FAKE_GROK_LOG: fakeGrokLog })
    }
  );

  assert.equal(result.status, 0, result.stderr);
  const argv = lastFakeGrokArgv(fakeGrokLog);
  assert.ok(argv.includes("--model"));
  assert.equal(argv[argv.indexOf("--model") + 1], "grok-build");
  assert.ok(argv.includes("--effort"));
  assert.equal(argv[argv.indexOf("--effort") + 1], "high");
});

test("critique returns structured findings payload path", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepo();

  const result = run("node", [SCRIPT, "critique", "--json", "focus on docs"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.review, "Critique");
  assert.equal(payload.result?.verdict, "approve");
  assert.ok(Array.isArray(payload.result?.findings));
});

test("run delegates through fake grok and stores a finished job", () => {
  const { repo, binDir, pluginDataDir } = setupCommittedRepo();

  const result = run("node", [SCRIPT, "run", "check auth preflight"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);

  withCodexData(pluginDataDir, () => {
    const jobs = listJobs(repo);
    assert.ok(jobs.length >= 1);
    assert.equal(jobs[0].jobClass, "task");
    assert.equal(jobs[0].status, "completed");
  });
});

test("runs and show surface the latest finished run as JSON", () => {
  const { repo, binDir, pluginDataDir } = setupCommittedRepo();

  const task = run("node", [SCRIPT, "run", "--json", "do a small thing"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(task.status, 0, task.stderr);

  const status = run("node", [SCRIPT, "runs", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout);
  assert.ok(statusPayload.latestFinished);
  assert.equal(statusPayload.latestFinished.status, "completed");
  assert.equal(statusPayload.latestFinished.jobClass, "task");
  assert.ok(statusPayload.latestFinished.threadId);

  const result = run("node", [SCRIPT, "show", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const showPayload = JSON.parse(result.stdout);
  assert.equal(showPayload.job.status, "completed");
  assert.equal(showPayload.job.jobClass, "task");
  assert.equal(showPayload.job.threadId, statusPayload.latestFinished.threadId);
  assert.match(showPayload.storedJob?.result?.rawOutput ?? "", /Handled the requested task/);
});

test("run-resume-candidate reports the latest workspace task and threadId", () => {
  const { repo, binDir, pluginDataDir } = setupCommittedRepo();

  const task = run("node", [SCRIPT, "run", "first task"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(task.status, 0, task.stderr);

  const candidate = run("node", [SCRIPT, "run-resume-candidate", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  const payload = JSON.parse(candidate.stdout);
  assert.equal(payload.available, true);
  assert.ok(payload.candidate?.threadId);
  assert.equal(payload.threadId, payload.candidate.threadId);
});

test("run --resume-last passes the stored thread ID to fake Grok", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupCommittedRepo();

  const first = run("node", [SCRIPT, "run", "first task"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(first.status, 0, first.stderr);

  const candidate = run("node", [SCRIPT, "run-resume-candidate", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  const payload = JSON.parse(candidate.stdout);
  const threadId = payload.threadId ?? payload.candidate?.threadId;
  assert.ok(threadId);

  const resume = run("node", [SCRIPT, "run", "--resume-last"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_GROK_LOG: fakeGrokLog })
  });
  assert.equal(resume.status, 0, resume.stderr);
  const argv = lastFakeGrokArgv(fakeGrokLog);
  assert.ok(argv.includes("-r"), argv.join(" "));
  assert.equal(argv[argv.indexOf("-r") + 1], threadId);
});

test("stop terminates a tracked sleeper process and marks run cancelled", () => {
  const { repo, binDir, pluginDataDir } = setupCommittedRepo();

  const agent = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
    cwd: repo,
    stdio: "ignore",
    detached: true
  });
  agent.unref();
  const bridge = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1000)"], {
    cwd: repo,
    stdio: "ignore",
    detached: true
  });
  bridge.unref();
  const agentPid = agent.pid;
  const bridgePid = bridge.pid;

  try {
    withCodexData(pluginDataDir, () => {
      const jobId = generateJobId("run");
      const jobsDir = path.join(resolveStateDir(repo), "jobs");
      fs.mkdirSync(jobsDir, { recursive: true });
      const logFile = path.join(jobsDir, `${jobId}.log`);
      fs.writeFileSync(logFile, "", "utf8");
      const job = {
        id: jobId,
        kind: "task",
        kindLabel: "delegate",
        title: "Grok Build Delegate",
        workspaceRoot: repo,
        jobClass: "task",
        summary: "fake running",
        status: "running",
        phase: "running",
        bridgePid,
        pid: bridgePid,
        agentPid,
        logFile,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      writeJobFile(repo, jobId, job);
      upsertJob(repo, job);

      const result = run("node", [SCRIPT, "stop", jobId, "--json"], {
        cwd: repo,
        env: pluginDataEnv(pluginDataDir, binDir)
      });

      assert.equal(result.status, 0, result.stderr);
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.status, "cancelled");
      assert.equal(payload.jobId, jobId);
      assert.equal(payload.killDelivered, true);
      assert.ok(payload.killTargets?.includes(agentPid));
      assert.ok(payload.killTargets?.includes(bridgePid));

      const jobs = listJobs(repo);
      const cancelled = jobs.find((entry) => entry.id === jobId);
      assert.equal(cancelled?.status, "cancelled");

      assert.equal(processAlive(agentPid), false);
      assert.equal(processAlive(bridgePid), false);
    });
  } finally {
    for (const pid of [agentPid, bridgePid]) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already dead
        }
      }
    }
  }
});

test("stop without a run id is rejected when two jobs are active", () => {
  const { repo, binDir, pluginDataDir } = setupCommittedRepo();

  withCodexData(pluginDataDir, () => {
    const now = new Date().toISOString();
    for (const id of ["run-one", "run-two"]) {
      const job = {
        id,
        kind: "task",
        kindLabel: "delegate",
        title: "Grok Build Delegate",
        workspaceRoot: repo,
        jobClass: "task",
        summary: id,
        status: "running",
        phase: "running",
        createdAt: now,
        updatedAt: now
      };
      writeJobFile(repo, id, job);
      upsertJob(repo, job);
    }

    const result = run("node", [SCRIPT, "stop", "--json"], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(`${result.stdout}\n${result.stderr}`, /Multiple Grok Build runs are active/);
  });
});
