import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { processIsAlive } from "./process.mjs";
import { withStateFileLock } from "./state-lock.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

const STATE_VERSION = 1;
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
const FALLBACK_STATE_ROOT_DIR = path.join(os.tmpdir(), "grok-cc-runs");
const STATE_FILE_NAME = "state.json";
const LOCK_FILE_NAME = "state.json.lock";
const JOBS_DIR_NAME = "jobs";
const MAX_JOBS = 50;

function nowIso() {
  return new Date().toISOString();
}

function defaultState() {
  return {
    version: STATE_VERSION,
    config: {},
    jobs: []
  };
}

function resolveBridgePidField(existing = {}, patch = {}) {
  if (patch.bridgePid !== undefined) {
    return patch.bridgePid;
  }
  if (patch.companionPid !== undefined) {
    return patch.companionPid;
  }
  return existing.bridgePid ?? existing.companionPid ?? null;
}

export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[PLUGIN_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

export function ensureStateDir(cwd) {
  fs.mkdirSync(resolveJobsDir(cwd), { recursive: true });
}

function writeFileAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`
  );
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, filePath);
}

export function withStateLock(cwd, fn) {
  ensureStateDir(cwd);
  const lockPath = path.join(resolveStateDir(cwd), LOCK_FILE_NAME);
  return withStateFileLock(lockPath, fn);
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export function isTerminalJobStatus(status) {
  return TERMINAL_STATUSES.has(status);
}

function readJobFileIfPresent(cwd, jobId) {
  const jobFile = resolveJobFile(cwd, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

function writeJobFileUnlocked(cwd, jobId, payload) {
  ensureStateDir(cwd);
  writeFileAtomic(resolveJobFile(cwd, jobId), `${JSON.stringify(payload, null, 2)}\n`);
}

function upsertJobInState(state, jobPatch) {
  const timestamp = nowIso();
  const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
  if (existingIndex === -1) {
    state.jobs.unshift({
      createdAt: timestamp,
      updatedAt: timestamp,
      ...jobPatch
    });
    return;
  }
  state.jobs[existingIndex] = {
    ...state.jobs[existingIndex],
    ...jobPatch,
    updatedAt: timestamp
  };
}

function jobIndexPatch(job, existing) {
  const terminal = isTerminalJobStatus(job.status);
  return {
    id: job.id,
    status: job.status,
    phase: job.phase ?? (job.status === "completed" ? "done" : job.status),
    summary: job.summary ?? existing.summary,
    threadId: job.threadId ?? existing.threadId ?? null,
    turnId: job.turnId ?? existing.turnId ?? null,
    pid: terminal ? null : (job.pid ?? null),
    agentPid: terminal ? null : (job.agentPid ?? null),
    bridgePid: job.bridgePid ?? null,
    errorMessage: job.errorMessage,
    completedAt: job.completedAt,
    logFile: job.logFile ?? existing.logFile ?? null,
    sessionId: job.sessionId ?? existing.sessionId,
    kind: job.kind ?? existing.kind,
    kindLabel: job.kindLabel ?? existing.kindLabel,
    title: job.title ?? existing.title,
    jobClass: job.jobClass ?? existing.jobClass,
    write: job.write ?? existing.write
  };
}

/** Claim terminal status for job file + index under one lock. cancelled wins. */
export function claimJobTerminal(cwd, jobId, nextStatus, patch = {}) {
  if (!isTerminalJobStatus(nextStatus)) {
    throw new Error(`claimJobTerminal requires a terminal status, got: ${nextStatus}`);
  }

  return withStateLock(cwd, () => claimJobTerminalUnlocked(cwd, jobId, nextStatus, patch, loadState(cwd)));
}

function claimJobTerminalUnlocked(cwd, jobId, nextStatus, patch, state) {
  const existingFile = readJobFileIfPresent(cwd, jobId);
  const indexJob = state.jobs.find((job) => job.id === jobId) ?? null;
  const existing = existingFile ?? indexJob;

  if (!existing) {
    return { claimed: false, status: null, job: null, reason: "missing" };
  }

  const currentStatus = existing.status;
  if (isTerminalJobStatus(currentStatus)) {
    if (currentStatus === "cancelled" && nextStatus !== "cancelled") {
      return { claimed: false, status: "cancelled", job: existing, reason: "cancelled-wins" };
    }
    if (nextStatus === "cancelled" && currentStatus !== "cancelled") {
      return { claimed: false, status: currentStatus, job: existing, reason: "already-terminal" };
    }
    if (currentStatus === "cancelled" && nextStatus === "cancelled") {
      const merged = {
        ...existing,
        ...patch,
        id: jobId,
        status: "cancelled",
        phase: "cancelled",
        pid: null,
        agentPid: null,
        updatedAt: nowIso()
      };
      writeJobFileUnlocked(cwd, jobId, merged);
      upsertJobInState(state, {
        id: jobId,
        status: "cancelled",
        phase: "cancelled",
        summary: merged.summary ?? existing.summary,
        threadId: merged.threadId ?? existing.threadId ?? null,
        pid: null,
        agentPid: null,
        errorMessage: merged.errorMessage ?? existing.errorMessage
      });
      saveStateUnlocked(cwd, state);
      return { claimed: false, status: "cancelled", job: merged, reason: "cancelled-merge" };
    }
    return { claimed: false, status: currentStatus, job: existing, reason: "already-terminal" };
  }

  const completedAt = patch.completedAt ?? nowIso();
  const nextJob = {
    ...existing,
    ...patch,
    id: jobId,
    status: nextStatus,
    phase: patch.phase ?? (nextStatus === "completed" ? "done" : nextStatus),
    pid: patch.pid === undefined ? null : patch.pid,
    agentPid: patch.agentPid === undefined ? null : patch.agentPid,
    bridgePid: resolveBridgePidField(existing, patch),
    completedAt,
    updatedAt: nowIso()
  };
  if (nextStatus === "cancelled") {
    nextJob.cancelledAt = patch.cancelledAt ?? completedAt;
  }

  writeJobFileUnlocked(cwd, jobId, nextJob);
  upsertJobInState(state, jobIndexPatch(nextJob, existing));
  saveStateUnlocked(cwd, state);
  return { claimed: true, status: nextStatus, job: nextJob, reason: "claimed" };
}

/** Patch non-terminal job under lock; no-op if missing/terminal. */
export function patchJobIfActive(cwd, jobId, patch = {}) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    const existingFile = readJobFileIfPresent(cwd, jobId);
    const indexJob = state.jobs.find((job) => job.id === jobId) ?? null;
    const existing = existingFile ?? indexJob;
    if (!existing) {
      return { patched: false, status: null, job: null, reason: "missing" };
    }
    if (isTerminalJobStatus(existing.status)) {
      return { patched: false, status: existing.status, job: existing, reason: "terminal" };
    }

    const bridgePid = resolveBridgePidField(existing, patch);
    const nextJob = {
      ...existing,
      ...patch,
      id: jobId,
      bridgePid,
      agentPid: patch.agentPid !== undefined ? patch.agentPid : (existing.agentPid ?? null),
      pid:
        patch.pid !== undefined
          ? patch.pid
          : (bridgePid ?? existing.pid ?? null),
      updatedAt: nowIso()
    };

    writeJobFileUnlocked(cwd, jobId, nextJob);
    upsertJobInState(state, {
      id: jobId,
      status: nextJob.status,
      phase: nextJob.phase,
      summary: nextJob.summary,
      threadId: nextJob.threadId,
      turnId: nextJob.turnId,
      pid: nextJob.pid,
      agentPid: nextJob.agentPid,
      bridgePid: nextJob.bridgePid,
      logFile: nextJob.logFile,
      errorMessage: nextJob.errorMessage
    });
    saveStateUnlocked(cwd, state);
    return { patched: true, status: nextJob.status, job: nextJob, reason: "patched" };
  });
}

export function loadState(cwd) {
  const stateFile = resolveStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return defaultState();
  }

  let raw = "";
  try {
    raw = fs.readFileSync(stateFile, "utf8");
  } catch (error) {
    throw new Error(`Failed to read bridge state file ${stateFile}: ${error.message}`);
  }

  if (!raw.trim()) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      ...defaultState(),
      ...parsed,
      config: {
        ...defaultState().config,
        ...(parsed.config ?? {})
      },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch (error) {
    const quarantinePath = `${stateFile}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(stateFile, quarantinePath);
    } catch {
    }
    throw new Error(
      `Bridge state file is corrupt and was quarantined${quarantinePath ? ` to ${quarantinePath}` : ""}: ${error.message}`
    );
  }
}

function pruneJobs(jobs) {
  return [...jobs]
    .sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")))
    .slice(0, MAX_JOBS);
}

function removeFileIfExists(filePath) {
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function saveStateUnlocked(cwd, state) {
  const previousJobs = loadState(cwd).jobs;
  ensureStateDir(cwd);
  const nextJobs = pruneJobs(state.jobs ?? []);
  const nextState = {
    version: STATE_VERSION,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    jobs: nextJobs
  };

  const retainedIds = new Set(nextJobs.map((job) => job.id));
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    removeJobFile(resolveJobFile(cwd, job.id));
    removeFileIfExists(job.logFile);
  }

  writeFileAtomic(resolveStateFile(cwd), `${JSON.stringify(nextState, null, 2)}\n`);
  return nextState;
}

export function saveState(cwd, state) {
  return withStateLock(cwd, () => saveStateUnlocked(cwd, state));
}

export function updateState(cwd, mutate) {
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    mutate(state);
    return saveStateUnlocked(cwd, state);
  });
}

export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

export function upsertJob(cwd, jobPatch) {
  return updateState(cwd, (state) => {
    const timestamp = nowIso();
    const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
    if (existingIndex === -1) {
      state.jobs.unshift({
        createdAt: timestamp,
        updatedAt: timestamp,
        ...jobPatch
      });
      return;
    }
    state.jobs[existingIndex] = {
      ...state.jobs[existingIndex],
      ...jobPatch,
      updatedAt: timestamp
    };
  });
}

function hasIndexChanges(job, indexed) {
  return Object.entries(jobIndexPatch(job, indexed)).some(([key, value]) => indexed[key] !== value);
}

function recordedProcessesExited(job, isAlive) {
  if (job.status !== "queued" && job.status !== "running") return false;
  const pids = [job.bridgePid ?? job.companionPid ?? job.pid, job.agentPid];
  // An agent can exist before its PID is published. Missing, live/reused or
  // uninspectable PIDs are not permission to terminate the job record.
  if (!pids.every((pid) => Number.isSafeInteger(pid) && pid > 0)) return false;
  try {
    return pids.every((pid) => isAlive(pid) === false);
  } catch {
    return false;
  }
}

/** Reconcile only explicitly selected jobs, using fresh records under the state lock. */
export function reconcileJobs(cwd, jobIds, options = {}) {
  if (jobIds.length === 0) return listJobs(cwd);
  const selected = new Set(jobIds);
  const isAlive = options.isAliveImpl ?? processIsAlive;
  const snapshot = listJobs(cwd);
  // Keep ordinary status reads available while a writer holds the lock. This
  // optimistic check never authorizes a write; recheck every record below.
  const needsRepair = snapshot.some((indexed) => {
    if (!selected.has(indexed.id)) return false;
    const job = readJobFileIfPresent(cwd, indexed.id) ?? indexed;
    return hasIndexChanges(job, indexed) || recordedProcessesExited(job, isAlive);
  });
  if (!needsRepair) return snapshot;
  return withStateLock(cwd, () => {
    const state = loadState(cwd);
    let repairedIndex = false;
    for (const indexJob of state.jobs) {
      if (!selected.has(indexJob.id)) continue;
      const job = readJobFileIfPresent(cwd, indexJob.id) ?? indexJob;
      if (isTerminalJobStatus(job.status) || job.status === "queued" || job.status === "running") {
        // A killed writer may have saved the job before its index. Preserve
        // the authoritative record, including live PIDs and terminal results.
        const patch = jobIndexPatch(job, indexJob);
        if (hasIndexChanges(job, indexJob)) {
          upsertJobInState(state, patch);
          repairedIndex = true;
        }
      }
      if (!recordedProcessesExited(job, isAlive)) continue;
      claimJobTerminalUnlocked(cwd, job.id, "failed", {
        errorMessage: "Run interrupted: the recorded bridge and Grok processes have exited without a terminal result.",
        bridgePid: null,
        agentPid: null,
        pid: null
      }, state);
    }
    if (repairedIndex) saveStateUnlocked(cwd, state);
    return state.jobs;
  });
}

export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

export function setConfig(cwd, key, value) {
  return updateState(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  });
}

export function getConfig(cwd) {
  return loadState(cwd).config;
}

export function writeJobFile(cwd, jobId, payload) {
  ensureStateDir(cwd);
  const jobFile = resolveJobFile(cwd, jobId);
  writeFileAtomic(jobFile, `${JSON.stringify(payload, null, 2)}\n`);
  return jobFile;
}

export function readJobFile(jobFile) {
  return JSON.parse(fs.readFileSync(jobFile, "utf8"));
}

function removeJobFile(jobFile) {
  if (fs.existsSync(jobFile)) {
    fs.unlinkSync(jobFile);
  }
}

export function resolveJobLogFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}

export function resolveJobFile(cwd, jobId) {
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.json`);
}
