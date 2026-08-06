import fs from "node:fs";
import process from "node:process";

import {
  claimJobTerminal,
  isTerminalJobStatus,
  patchJobIfActive,
  readJobFile,
  resolveJobFile,
  resolveJobLogFile,
  upsertJob,
  writeJobFile
} from "./state.mjs";

export const SESSION_ID_ENV = "GROK_CC_SESSION_ID";

export function nowIso() {
  return new Date().toISOString();
}

function normalizeProgressEvent(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const agentPidRaw = value.agentPid ?? null;
    const agentPid = Number.isFinite(Number(agentPidRaw)) ? Number(agentPidRaw) : null;
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      agentPid,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    agentPid: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  fs.appendFileSync(logFile, `[${nowIso()}] ${normalized}\n`, "utf8");
}

export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  fs.appendFileSync(logFile, `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`, "utf8");
}

export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  fs.writeFileSync(logFile, "", "utf8");
  if (title) {
    appendLogLine(logFile, `Starting ${title}.`);
  }
  return logFile;
}

export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

export function createJobProgressUpdater(workspaceRoot, jobId) {
  let lastPhase = null;
  let lastThreadId = null;
  let lastTurnId = null;
  let lastAgentPid = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    const patch = {};
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (normalized.agentPid && normalized.agentPid !== lastAgentPid) {
      lastAgentPid = normalized.agentPid;
      patch.agentPid = normalized.agentPid;
      changed = true;
    }

    if (!changed) {
      return;
    }

    patchJobIfActive(workspaceRoot, jobId, patch);
  };
}

export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[grok-cc] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

function readStoredJobOrNull(workspaceRoot, jobId) {
  const jobFile = resolveJobFile(workspaceRoot, jobId);
  if (!fs.existsSync(jobFile)) {
    return null;
  }
  return readJobFile(jobFile);
}

export function resolveJobKillTargets(job = {}) {
  const targets = [];
  const seen = new Set();
  // Prefer bridgePid; accept legacy companionPid for older run records.
  for (const value of [job.agentPid, job.bridgePid, job.companionPid, job.pid]) {
    if (value == null || value === "") {
      continue;
    }
    const pid = Number(value);
    if (!Number.isFinite(pid) || pid <= 0 || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    targets.push(pid);
  }
  return targets;
}

export async function runTrackedJob(job, runner, options = {}) {
  const bridgePid = process.pid;
  const logFile = options.logFile ?? job.logFile ?? null;
  const runningPatch = {
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    bridgePid,
    pid: bridgePid,
    agentPid: job.agentPid ?? null,
    logFile
  };

  const activated = patchJobIfActive(job.workspaceRoot, job.id, runningPatch);
  if (!activated.patched) {
    if (activated.reason === "missing") {
      writeJobFile(job.workspaceRoot, job.id, {
        ...job,
        ...runningPatch,
        id: job.id
      });
      upsertJob(job.workspaceRoot, {
        id: job.id,
        ...runningPatch,
        kind: job.kind,
        kindLabel: job.kindLabel,
        title: job.title,
        jobClass: job.jobClass,
        summary: job.summary,
        write: job.write,
        sessionId: job.sessionId
      });
      const recheck = patchJobIfActive(job.workspaceRoot, job.id, runningPatch);
      if (!recheck.patched && isTerminalJobStatus(recheck.status)) {
        return {
          exitStatus: 1,
          threadId: recheck.job?.threadId ?? null,
          turnId: null,
          payload: recheck.job?.result ?? { status: recheck.status },
          rendered: recheck.job?.rendered ?? `Run ${job.id} is already ${recheck.status}.\n`,
          summary: recheck.job?.summary ?? recheck.status,
          cancelled: recheck.status === "cancelled",
          pruned: false,
          alreadyTerminal: true
        };
      }
    } else if (isTerminalJobStatus(activated.status)) {
      return {
        exitStatus: 1,
        threadId: activated.job?.threadId ?? null,
        turnId: null,
        payload: activated.job?.result ?? { status: activated.status },
        rendered: activated.job?.rendered ?? `Run ${job.id} is already ${activated.status}.\n`,
        summary: activated.job?.summary ?? activated.status,
        cancelled: activated.status === "cancelled",
        pruned: false,
        alreadyTerminal: true
      };
    }
  }

  try {
    const execution = await runner();

    // fleet#254: a zero exit code reports process health, not work completion. A run whose model
    // emitted a plan and ended its turn exits 0 exactly like a run that did the job. Demote such
    // a run to `failed` so no caller can read `completed` as evidence of work.
    const workVerdict = execution.workVerdict ?? null;
    const emptyRun = Boolean(workVerdict?.noWork);
    const completionStatus = execution.exitStatus === 0 && !emptyRun ? "completed" : "failed";
    if (emptyRun) {
      appendLogLine(
        options.logFile ?? job.logFile ?? null,
        `EMPTY RUN: marking ${job.id} FAILED despite exit ${execution.exitStatus}. ${(workVerdict.reasons ?? []).join(" ")}`
      );
    } else if (workVerdict?.unverified) {
      appendLogLine(
        options.logFile ?? job.logFile ?? null,
        `UNVERIFIED RUN: ${job.id} produced no work telemetry; completion is not evidence of work.`
      );
    }

    const claim = claimJobTerminal(job.workspaceRoot, job.id, completionStatus, {
      threadId: execution.threadId ?? null,
      turnId: execution.turnId ?? null,
      summary: execution.summary,
      result: execution.payload,
      rendered: execution.rendered,
      workEvidence: workVerdict?.evidence ?? null,
      emptyRun,
      bridgePid,
      agentPid: null,
      pid: null,
      phase: completionStatus === "completed" ? "done" : "failed",
      errorMessage: emptyRun ? (workVerdict.reasons ?? []).join(" ") : undefined,
      logFile: options.logFile ?? job.logFile ?? null
    });

    if (!claim.claimed && claim.status === "cancelled") {
      claimJobTerminal(job.workspaceRoot, job.id, "cancelled", {
        threadId: execution.threadId ?? claim.job?.threadId ?? null,
        turnId: execution.turnId ?? claim.job?.turnId ?? null,
        summary: claim.job?.summary ?? execution.summary,
        result: claim.job?.result ?? execution.payload,
        rendered: claim.job?.rendered ?? execution.rendered,
        partialResult: execution.payload,
        bridgePid: null,
        agentPid: null,
        pid: null,
        logFile: options.logFile ?? job.logFile ?? null
      });
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output (after cancel)", execution.rendered);
      return {
        ...execution,
        cancelled: true
      };
    }

    if (!claim.claimed && claim.reason === "missing") {
      appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output (run missing)", execution.rendered);
      return {
        ...execution,
        pruned: true
      };
    }

    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const claim = claimJobTerminal(job.workspaceRoot, job.id, "failed", {
      errorMessage,
      bridgePid: null,
      agentPid: null,
      pid: null,
      phase: "failed",
      logFile: options.logFile ?? job.logFile ?? null
    });

    if (!claim.claimed && claim.status === "cancelled") {
      throw error;
    }
    if (!claim.claimed && claim.reason === "missing") {
      throw error;
    }
    throw error;
  }
}

export { isTerminalJobStatus, claimJobTerminal, patchJobIfActive };
