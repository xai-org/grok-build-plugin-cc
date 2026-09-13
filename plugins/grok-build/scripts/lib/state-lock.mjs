import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { processIsAlive } from "./process.mjs";

const LOCK_MAX_ATTEMPTS = 100;
const LOCK_RETRY_MS = 20;
const OWNER_NAME = /^owner-([a-f0-9-]{36})\.json$/;
const CONTENDED_ERRORS = new Set(["EEXIST", "ENOTEMPTY", "EISDIR", "ENOTDIR", "EPERM", "EACCES"]);

function removeEmptyDirectory(lockPath) {
  try {
    // Never remove recursively: a replacement owner always has a marker.
    fs.rmdirSync(lockPath);
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST", "ENOTDIR"].includes(error?.code)) throw error;
  }
}

function releaseOwner(lockPath, ownerName) {
  try {
    // A delayed release/reaper can remove only its observed acquisition.
    fs.unlinkSync(path.join(lockPath, ownerName));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return;
    throw error;
  }
  removeEmptyDirectory(lockPath);
}

function tryRecoverLock(lockPath) {
  try {
    if (!fs.lstatSync(lockPath).isDirectory()) {
      return "Legacy or unrecognized lock; ownership cannot be verified.";
    }
    const entries = fs.readdirSync(lockPath);
    if (entries.length === 0) {
      // Only release/recovery empties a published directory. This also supports
      // platforms that cannot rename over an existing empty directory.
      removeEmptyDirectory(lockPath);
      return "Retired lock directory.";
    }
    const match = entries.length === 1 && OWNER_NAME.exec(entries[0]);
    if (!match) return "Unrecognized lock contents; ownership cannot be verified.";
    let owner;
    try {
      owner = JSON.parse(fs.readFileSync(path.join(lockPath, entries[0]), "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return "Lock ownership changed.";
      if (error instanceof SyntaxError) return "Malformed lock metadata; ownership cannot be verified.";
      throw error;
    }
    if (owner?.version !== 1 || owner.token !== match[1] ||
        !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.hostname !== os.hostname()) {
      return "Unrecognized or different-host lock owner; ownership cannot be verified.";
    }
    try {
      if (processIsAlive(owner.pid)) return `Owner process ${owner.pid} is still present.`;
    } catch {
      return `Liveness of owner process ${owner.pid} cannot be verified.`;
    }
    releaseOwner(lockPath, entries[0]);
    return `Recovered lock from exited process ${owner.pid}.`;
  } catch (error) {
    if (error?.code === "ENOENT") return "Lock ownership changed.";
    throw error;
  }
}

export function withStateFileLock(lockPath, fn) {
  const token = randomUUID();
  const ownerName = `owner-${token}.json`;
  const candidatePath = fs.mkdtempSync(`${lockPath}.pending-`);
  let acquired = false;
  let detail = "";
  const deadline = performance.now() + LOCK_MAX_ATTEMPTS * LOCK_RETRY_MS;
  try {
    fs.writeFileSync(path.join(candidatePath, ownerName), JSON.stringify({
      version: 1, token, pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString()
    }), { encoding: "utf8", mode: 0o600 });

    for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt += 1) {
      try {
        // Publish complete ownership atomically. A nonempty existing directory
        // cannot be replaced, so there is no ownerless acquisition window.
        fs.renameSync(candidatePath, lockPath);
        acquired = true;
        return fn();
      } catch (error) {
        if (acquired || !CONTENDED_ERRORS.has(error?.code)) throw error;
        detail = tryRecoverLock(lockPath);
        if (performance.now() >= deadline) break;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
      }
    }
    throw new Error(`Timed out acquiring state lock at ${lockPath}. ${detail} ` +
      "For manual repair, stop all bridge, worker and Grok processes using this workspace before moving the lock aside. Keep state.json and jobs intact.");
  } finally {
    if (acquired) releaseOwner(lockPath, ownerName);
    else fs.rmSync(candidatePath, { recursive: true, force: true });
  }
}
