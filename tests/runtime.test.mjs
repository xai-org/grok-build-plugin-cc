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
} from "../plugins/grok-build/scripts/lib/state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "grok-build");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "grok-bridge.mjs");

function pluginDataEnv(pluginDataDir, binDir, extra = {}) {
  return buildEnv(binDir, {
    CLAUDE_PLUGIN_DATA: pluginDataDir,
    ...extra
  });
}

test("check reports ready when fake grok is installed and authenticated", () => {
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
  assert.equal(payload.grok.available, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.sessionRuntime.mode, "plugin-owned");
  assert.equal(payload.reviewGateEnabled, undefined);
});

test("check reports not ready when models probe fails", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir, "not-logged-in");

  const result = run("node", [SCRIPT, "check", "--json"], {
    cwd: ROOT,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.ok(payload.nextSteps.length > 0);
});

test("check ignores legacy review-gate flags as unknown options", () => {
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);

  const result = run("node", [SCRIPT, "check", "--enable-review-gate", "--json"], {
    cwd: ROOT,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.reviewGateEnabled, undefined);
  assert.match(result.stderr, /ignoring unknown option/);
});

test("review renders a no-findings style result from fake grok", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reviewed uncommitted changes|No material issues found/i);
  assert.match(result.stdout, /Grok Build Review|Target:/);
});

test("critique returns structured findings payload path", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello world\n");

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

test("critique forwards --model and --effort to grok", () => {
  const { repo, binDir, pluginDataDir, fakeGrokLog } = setupReviewableRepo();

  const result = run(
    "node",
    [SCRIPT, "critique", "--model", "grok-build", "--effort", "medium", "focus on race conditions"],
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
  assert.equal(argv[argv.indexOf("--effort") + 1], "medium");
});

test("review rejects unsupported --effort values", () => {
  const { repo, binDir, pluginDataDir } = setupReviewableRepo();

  for (const effort of ["extreme", "xhigh", "max"]) {
    const result = run("node", [SCRIPT, "review", "--effort", effort], {
      cwd: repo,
      env: pluginDataEnv(pluginDataDir, binDir)
    });

    assert.notEqual(result.status, 0, `expected rejection for --effort ${effort}`);
    assert.match(`${result.stdout}\n${result.stderr}`, /Unsupported reasoning effort/i);
  }
});

test("run delegates through fake grok and stores a finished job", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "run", "check auth preflight"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
    const jobs = listJobs(repo);
    assert.ok(jobs.length >= 1);
    assert.equal(jobs[0].jobClass, "task");
    assert.equal(jobs[0].status, "completed");
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

test("run --prompt-file forwards the path to grok instead of inlining the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  const fakeGrokLog = path.join(pluginDataDir, "fake-grok.log");
  installFakeGrok(binDir);
  initGitRepo(repo);

  // Large enough that inlining it into argv would exceed the Windows
  // CreateProcess command-line limit (32,767 chars) and fail the spawn.
  const promptFile = path.join(repo, "prompt.txt");
  fs.writeFileSync(promptFile, `summarize this repository\n${"x".repeat(40000)}\n`);

  const result = run("node", [SCRIPT, "run", "--prompt-file", promptFile], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, { FAKE_GROK_LOG: fakeGrokLog })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);

  const lines = fs
    .readFileSync(fakeGrokLog, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const promptRun = [...lines].reverse().find((entry) => entry.argv?.includes("--prompt-file"));
  assert.ok(promptRun, "expected a headless grok --prompt-file invocation");
  const argv = promptRun.argv;
  assert.equal(argv[argv.indexOf("--prompt-file") + 1], promptFile);
  assert.ok(!argv.includes("-p"));
  assert.ok(
    argv.every((arg) => !arg.includes("xxxx")),
    "prompt contents must not appear in argv"
  );
});

test("runs and show surface the latest finished run", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

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
  assert.equal(statusPayload.needsReview, undefined);

  const result = run("node", [SCRIPT, "show"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task|Grok session ID|Run:/);
});

function processAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    return error?.code !== "ESRCH";
  }
  // Zombies still accept kill(0); treat them as not running.
  const ps = run("ps", ["-p", String(pid), "-o", "stat="]);
  const stat = String(ps.stdout ?? "").trim().toUpperCase();
  if (!stat || stat.includes("Z")) {
    return false;
  }
  return true;
}

test("stop terminates a tracked sleeper process and marks run cancelled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

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

  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;
  try {
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

    // Both process trees must actually be dead.
    assert.equal(processAlive(agentPid), false);
    assert.equal(processAlive(bridgePid), false);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
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

test("enqueueBackgroundJob writes the job file before spawning the worker", async () => {
  const { enqueueBackgroundJob } = await import("../plugins/grok-build/scripts/grok-bridge.mjs");
  const repo = makeTempDir();
  const pluginDataDir = makeTempDir();
  const previous = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CLAUDE_PLUGIN_DATA = pluginDataDir;

  try {
    const events = [];
    const job = {
      id: generateJobId("run"),
      kind: "task",
      kindLabel: "delegate",
      title: "Grok Build Delegate",
      workspaceRoot: repo,
      jobClass: "task",
      summary: "bg order",
      write: false
    };

    const result = enqueueBackgroundJob(
      repo,
      job,
      { kind: "task", cwd: repo, prompt: "hello", write: false, resumeLast: false, jobId: job.id },
      {
        spawnWorker(cwd, jobId) {
          events.push("spawn");
          const stored = readStoredJobFromDisk(repo, jobId);
          events.push(stored ? "job-present-at-spawn" : "job-missing-at-spawn");
          assert.ok(stored, "job file must exist before worker spawn");
          assert.equal(stored.status, "queued");
          assert.equal(stored.pid, null);
          return { pid: 424242 };
        }
      }
    );

    assert.deepEqual(events, ["spawn", "job-present-at-spawn"]);
    assert.equal(result.payload.status, "queued");
    assert.equal(result.payload.pid, 424242);
    assert.equal(result.payload.bridgePid, 424242);
    const jobs = listJobs(repo);
    assert.equal(jobs[0].pid, 424242);
  } finally {
    if (previous == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previous;
    }
  }
});

function readStoredJobFromDisk(workspaceRoot, jobId) {
  const jobFile = path.join(resolveStateDir(workspaceRoot), "jobs", `${jobId}.json`);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

test("import uses grok import and prints resume hint", () => {
  const home = makeTempDir();
  const projects = path.join(home, ".claude", "projects", "demo");
  fs.mkdirSync(projects, { recursive: true });
  const sessionPath = path.join(projects, "sess-transfer.jsonl");
  fs.writeFileSync(sessionPath, '{"type":"user","text":"hi"}\n', "utf8");

  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);

  const result = run("node", [SCRIPT, "import", "--source", sessionPath, "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, {
      HOME: home,
      USERPROFILE: home
    })
  });

  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.threadId, "11111111-2222-4333-8444-555555555555");
  assert.equal(payload.resumeCommand, "grok -r 11111111-2222-4333-8444-555555555555");
});

test("run-resume-candidate reports available after a completed run with thread id", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const pluginDataDir = makeTempDir();
  installFakeGrok(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "a.txt"), "a\n");
  run("git", ["add", "a.txt"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const sessionId = "claude-session-1";
  const task = run("node", [SCRIPT, "run", "first task"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, {
      GROK_CC_SESSION_ID: sessionId
    })
  });
  assert.equal(task.status, 0, task.stderr);

  const candidate = run("node", [SCRIPT, "run-resume-candidate", "--json"], {
    cwd: repo,
    env: pluginDataEnv(pluginDataDir, binDir, {
      GROK_CC_SESSION_ID: sessionId
    })
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  const payload = JSON.parse(candidate.stdout);
  assert.equal(payload.available, true);
  assert.ok(payload.candidate?.threadId);
});
