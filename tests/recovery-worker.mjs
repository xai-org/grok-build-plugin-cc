import fs from "node:fs";
import path from "node:path";

import * as state from "../plugins/grok-build/scripts/lib/state.mjs";
import { buildStatusSnapshot } from "../plugins/grok-build/scripts/lib/job-control.mjs";

const { claimJobTerminal, resolveJobFile, resolveStateDir, updateState, withStateLock } = state;

const [mode, workspace, ready, release] = process.argv.slice(2);
const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);

function announce(value) {
  fs.writeFileSync(ready, JSON.stringify(value));
}

function waitUntilReleased(file) {
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error("Lock fixture release deadline exceeded");
    sleep();
  }
}

const lockPath = path.join(resolveStateDir(workspace), "state.json.lock");
if (mode === "status-pruned") {
  const read = fs.readFileSync;
  fs.readFileSync = (file, ...args) => {
    if (file === resolveJobFile(workspace, "pruned-run")) {
      announce({ beforeJobRead: true });
      waitUntilReleased(release);
    }
    return read(file, ...args);
  };
} else if (mode === "reap-hold") {
  const unlink = fs.unlinkSync;
  const rename = fs.renameSync;
  let observedDeadOwner = false;
  fs.unlinkSync = (file) => {
    if (!observedDeadOwner && path.dirname(file) === lockPath) {
      observedDeadOwner = true;
      announce({ beforeReap: true });
      waitUntilReleased(`${release}.reap`);
    }
    return unlink(file);
  };
  fs.renameSync = (from, to) => {
    try { return rename(from, to); } catch (error) {
      if (observedDeadOwner && to === lockPath) fs.writeFileSync(`${ready}.contended`, "yes");
      throw error;
    }
  };
} else if (mode === "empty-retired") {
  const rmdir = fs.rmdirSync;
  fs.rmdirSync = (file, ...args) => {
    if (file === lockPath) {
      announce({ afterReap: true });
      waitUntilReleased(release);
    }
    return rmdir(file, ...args);
  };
} else if (mode === "during-metadata") {
  const write = fs.writeFileSync;
  fs.writeFileSync = (file, ...args) => {
    if (path.dirname(file).startsWith(`${lockPath}.pending-`)) {
      write(file, "{partial");
      announce({ partialMetadata: true });
      waitUntilReleased(release);
    }
    return write(file, ...args);
  };
} else if (["before-publication", "after-publication", "terminal-write", "reconcile-paused"].includes(mode)) {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (["before-publication", "reconcile-paused"].includes(mode) && to === lockPath) {
      announce({ beforePublication: true });
      waitUntilReleased(release);
    }
    const result = rename(from, to);
    if ((mode === "after-publication" && to === lockPath) ||
        (mode === "terminal-write" && to === resolveJobFile(workspace, "interrupted-write"))) {
      announce({ afterPublication: true });
      waitUntilReleased(release);
    }
    return result;
  };
}

if (mode === "status-pruned") {
  const status = buildStatusSnapshot(workspace);
  fs.writeFileSync(`${ready}.status`, JSON.stringify(status));
} else if (mode === "reconcile-paused") {
  state.reconcileJobs(workspace, ["publication-race"]);
} else if (mode.startsWith("race-")) {
  announce({ waiting: true });
  waitUntilReleased(release);
  if (mode === "race-recovery") state.reconcileJobs(workspace, ["race-job"]);
  else claimJobTerminal(workspace, "race-job", mode.slice(5), { rendered: `${mode}\n` });
} else if (mode === "terminal-write") {
  claimJobTerminal(workspace, "interrupted-write", "completed", { result: { verified: true }, rendered: "Saved result.\n" });
} else if (mode === "reap-hold") {
  withStateLock(workspace, () => {
    fs.writeFileSync(`${ready}.acquired`, "yes");
    waitUntilReleased(`${release}.held`);
  });
} else if (["hold", "empty-retired", "during-metadata", "before-publication", "after-publication"].includes(mode)) {
  withStateLock(workspace, () => {
    announce({ pid: process.pid, held: true });
    waitUntilReleased(release);
  });
} else if (mode === "increment") {
  for (let index = 0; index < 8; index += 1) {
    updateState(workspace, (state) => {
      const sentinel = path.join(workspace, "critical-section");
      const fd = fs.openSync(sentinel, "wx");
      try {
        sleep();
        state.config.counter = (state.config.counter ?? 0) + 1;
      } finally {
        fs.closeSync(fd);
        fs.unlinkSync(sentinel);
      }
    });
  }
  announce({ done: true });
} else {
  throw new Error(`Unknown recovery fixture mode: ${mode}`);
}
