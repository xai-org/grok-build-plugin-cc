import { spawnSync } from "node:child_process";
import process from "node:process";

function sleepMs(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration <= 0) {
    return;
  }
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, duration);
}

export function runCommand(command, args = [], options = {}) {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  // Never enable a shell when passing a discrete args array. On Windows,
  // shell:true concatenates argv without escaping (Node DEP0190), so a
  // repository-controlled ref such as `main&probe.cmd` becomes a second
  // host command. Fixed binaries (git, grok, taskkill) must receive args
  // as an argv array on every platform.
  const result = spawnSyncImpl(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: false,
    windowsHide: true
  });

  const status = result.status == null ? (result.signal ? 1 : null) : result.status;

  return {
    command,
    args,
    status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command, args = [], options = {}) {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.signal || result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(command, versionArgs = ["--version"], options = {}) {
  const result = runCommand(command, versionArgs, options);
  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.signal || result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

function isZombieProcess(pid) {
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "stat="], {
      encoding: "utf8",
      windowsHide: true
    });
    if (result.error || result.status !== 0) {
      return true;
    }
    const stat = String(result.stdout ?? "").trim();
    if (!stat) {
      return true;
    }
    return /\bZ\b|^Z/i.test(stat) || stat.toUpperCase().includes("Z");
  } catch {
    return false;
  }
}

function processIsAlive(pid, killImpl) {
  try {
    killImpl(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") {
      return false;
    }
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return !isZombieProcess(pid);
    }
    throw error;
  }
  return !isZombieProcess(pid);
}

function tryKill(killImpl, pid, signal) {
  try {
    killImpl(pid, signal);
    return { ok: true, missing: false, denied: false };
  } catch (error) {
    if (error?.code === "ESRCH") {
      return { ok: false, missing: true, denied: false };
    }
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      return { ok: false, missing: false, denied: true };
    }
    throw error;
  }
}

export function terminateProcessTree(pid, options = {}) {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);
  const isAliveImpl =
    options.isAliveImpl ?? ((candidatePid) => processIsAlive(candidatePid, killImpl));
  const graceMs = options.graceMs ?? 200;

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      const direct = tryKill(killImpl, pid, "SIGTERM");
      if (direct.missing) {
        return { attempted: true, delivered: false, method: "kill" };
      }
      return { attempted: true, delivered: true, method: "kill" };
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  const methods = [];
  let signaledLiveProcess = false;

  const groupKill = tryKill(killImpl, -pid, "SIGTERM");
  if (groupKill.ok) {
    methods.push("process-group");
    signaledLiveProcess = true;
  } else if (groupKill.denied) {
    methods.push("process-group-denied");
  }

  if (isAliveImpl(pid)) {
    const directKill = tryKill(killImpl, pid, "SIGTERM");
    if (directKill.ok) {
      methods.push("process");
      signaledLiveProcess = true;
    } else if (directKill.missing) {
      return {
        attempted: true,
        delivered: signaledLiveProcess,
        method: methods.join("+") || "process"
      };
    } else if (directKill.denied) {
      methods.push("process-denied");
    }
  } else if (!signaledLiveProcess) {
    return {
      attempted: true,
      delivered: false,
      method: methods.join("+") || "process-group"
    };
  } else {
    return {
      attempted: true,
      delivered: true,
      method: methods.join("+") || "process-group"
    };
  }

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAliveImpl(pid)) {
      return { attempted: true, delivered: true, method: methods.join("+") || "process" };
    }
    sleepMs(20);
  }

  if (!isAliveImpl(pid)) {
    return { attempted: true, delivered: true, method: methods.join("+") || "process" };
  }

  const groupKillHard = tryKill(killImpl, -pid, "SIGKILL");
  if (groupKillHard.ok) {
    methods.push("process-group-sigkill");
  }
  if (isAliveImpl(pid)) {
    const directKillHard = tryKill(killImpl, pid, "SIGKILL");
    if (directKillHard.ok) {
      methods.push("process-sigkill");
    } else if (directKillHard.missing) {
      return { attempted: true, delivered: true, method: methods.join("+") || "process-sigkill" };
    }
  } else {
    return { attempted: true, delivered: true, method: methods.join("+") || "process-group-sigkill" };
  }

  sleepMs(40);
  const stillAlive = isAliveImpl(pid);
  return {
    attempted: true,
    delivered: !stillAlive,
    method: methods.join("+") || "process-sigkill"
  };
}

export function formatCommandFailure(result) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
