import test from "node:test";
import assert from "node:assert/strict";

import { processIsAlive, runCommand, terminateProcessTree } from "../plugins/grok-build/scripts/lib/process.mjs";

test("terminateProcessTree uses taskkill on Windows", () => {
  let captured = null;
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      captured = { command, args };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    },
    killImpl() {
      throw new Error("kill fallback should not run");
    }
  });

  assert.deepEqual(captured, {
    command: "taskkill",
    args: ["/PID", "1234", "/T", "/F"]
  });
  assert.equal(outcome.delivered, true);
  assert.equal(outcome.method, "taskkill");
});

test("terminateProcessTree treats missing Windows processes as already stopped", () => {
  const outcome = terminateProcessTree(1234, {
    platform: "win32",
    runCommandImpl(command, args) {
      return {
        command,
        args,
        status: 128,
        signal: null,
        stdout: 'ERROR: The process "1234" not found.',
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.method, "taskkill");
  assert.equal(outcome.result.status, 128);
  assert.match(outcome.result.stdout, /not found/i);
});

test("terminateProcessTree uses process-group SIGTERM then escalates to SIGKILL on posix", () => {
  const signals = [];
  let alive = true;
  const outcome = terminateProcessTree(4321, {
    platform: "darwin",
    graceMs: 40,
    isAliveImpl: () => alive,
    killImpl(pid, signal) {
      signals.push({ pid, signal });
      if (signal === 0) {
        if (!alive) {
          const error = new Error("no such process");
          error.code = "ESRCH";
          throw error;
        }
        return true;
      }
      if (signal === "SIGKILL") {
        alive = false;
      }
    }
  });

  assert.ok(signals.some((entry) => entry.pid === -4321 && entry.signal === "SIGTERM"));
  assert.ok(signals.some((entry) => entry.signal === "SIGKILL"));
  assert.equal(outcome.delivered, true);
  assert.match(outcome.method, /sigkill|process-group/);
});

test("terminateProcessTree reports delivered false when process is already gone", () => {
  const outcome = terminateProcessTree(999001, {
    platform: "darwin",
    killImpl() {
      const error = new Error("no such process");
      error.code = "ESRCH";
      throw error;
    }
  });

  assert.equal(outcome.attempted, true);
  assert.equal(outcome.delivered, false);
});

test("runCommand maps signalled exits to non-zero status", () => {
  const result = runCommand("unused", [], {
    spawnSyncImpl() {
      return {
        status: null,
        signal: "SIGTERM",
        stdout: "",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(result.status, 1);
  assert.equal(result.signal, "SIGTERM");
});

test("runCommand preserves explicit zero status without a signal", () => {
  const result = runCommand("unused", [], {
    spawnSyncImpl() {
      return {
        status: 0,
        signal: null,
        stdout: "ok\n",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(result.status, 0);
  assert.equal(result.signal, null);
});

test("runCommand honors an explicit shell override", () => {
  let captured = null;

  runCommand("git", ["status"], {
    shell: false,
    spawnSyncImpl(command, args, options) {
      captured = { command, args, options };
      return {
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(captured.command, "git");
  assert.deepEqual(captured.args, ["status"]);
  assert.equal(captured.options.shell, false);
});

test("runCommand keeps metacharacter args discrete when shell is disabled", () => {
  let captured = null;
  const maliciousRef = "main&probe.cmd";

  runCommand("git", ["merge-base", "HEAD", maliciousRef], {
    shell: false,
    spawnSyncImpl(command, args, options) {
      captured = { command, args, options };
      return {
        status: 0,
        signal: null,
        stdout: "abc123\n",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(captured.command, "git");
  assert.deepEqual(captured.args, ["merge-base", "HEAD", maliciousRef]);
  assert.equal(captured.options.shell, false);
  assert.equal(captured.args[2], maliciousRef);
  assert.ok(!captured.args.some((arg) => arg === "probe.cmd"));
});

test("processIsAlive requires positive evidence of death", () => {
  const gone = () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); };
  assert.equal(processIsAlive(123, { killImpl: gone }), false);
  for (const code of ["EPERM", "EACCES"]) {
    assert.equal(processIsAlive(123, {
      killImpl: () => { throw Object.assign(new Error("denied"), { code }); },
      spawnSyncImpl: () => { throw new Error("permission denial must not become zombie recovery"); }
    }), true);
  }
  assert.throws(() => processIsAlive(123, { killImpl: () => { throw new Error("unknown"); } }), /unknown/);
  for (const pid of [0, -1, null, "123", 1.5]) assert.throws(() => processIsAlive(pid), /Invalid process ID/);
});

test("processIsAlive protects a live or reused PID when process inspection fails", () => {
  for (const result of [{ error: new Error("missing ps") }, { status: 1 }, { status: 0, stdout: "" }]) {
    assert.equal(processIsAlive(123, { platform: "darwin", killImpl: () => {}, spawnSyncImpl: () => result }), true);
  }
  assert.equal(processIsAlive(123, {
    platform: "darwin", killImpl: () => {},
    spawnSyncImpl: (_command, _args, options) => {
      assert.equal(options.timeout, 1000);
      return { status: 0, stdout: "Z\n" };
    }
  }), false);
  assert.equal(processIsAlive(123, {
    platform: "win32", killImpl: () => {},
    spawnSyncImpl: () => { throw new Error("Windows must not depend on ps"); }
  }), true);
});
