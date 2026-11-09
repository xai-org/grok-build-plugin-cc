import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import process from "node:process";

import { readJsonFile } from "./fs.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";

export const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";

const DEFAULT_BINARY = "grok";
const BINARY_ENV = "GROK_BINARY";

export function resolveGrokBinary(env = process.env) {
  const override = env?.[BINARY_ENV];
  if (override && String(override).trim()) {
    return String(override).trim();
  }
  return DEFAULT_BINARY;
}

function invocationFor(binary) {
  if (
    process.platform === "win32" &&
    path.isAbsolute(binary) &&
    fs.existsSync(binary) &&
    !/\.exe$/i.test(binary)
  ) {
    // A GROK_BINARY script has no PATHEXT entry, so cmd would skip it and
    // launch a real grok.exe. Run that file with node instead.
    return {
      command: process.execPath,
      prefix: [binary],
      binary,
      shell: false
    };
  }
  return { command: binary, prefix: [], binary, shell: undefined };
}

export function runGrok(args = [], options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const invocation = invocationFor(binary);
  return runCommand(invocation.command, [...invocation.prefix, ...args], {
    cwd: options.cwd,
    env: options.env,
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio,
    shell: invocation.shell
  });
}

export function getGrokAvailability(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const invocation = invocationFor(binary);
  const versionStatus = binaryAvailable(invocation.command, [...invocation.prefix, "version"], {
    cwd,
    env: options.env,
    shell: invocation.shell
  });
  if (!versionStatus.available) {
    const alt = binaryAvailable(invocation.command, [...invocation.prefix, "--version"], {
      cwd,
      env: options.env,
      shell: invocation.shell
    });
    if (!alt.available) {
      return {
        available: false,
        detail: versionStatus.detail,
        binary
      };
    }
    return {
      available: true,
      detail: alt.detail,
      binary
    };
  }
  return {
    available: true,
    detail: versionStatus.detail,
    binary
  };
}

function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "models-probe",
    authMethod: null,
    verified: null,
    ...fields
  };
}

export function runModelsProbe(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const result = runGrok(["models"], {
    cwd,
    env: options.env,
    binary
  });

  if (result.error && /** @type {NodeJS.ErrnoException} */ (result.error).code === "ENOENT") {
    return buildAuthStatus({
      available: false,
      loggedIn: false,
      detail: "grok binary not found",
      source: "availability"
    });
  }

  if (result.error) {
    return buildAuthStatus({
      available: true,
      loggedIn: false,
      detail: result.error.message,
      source: "models-probe"
    });
  }

  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    return buildAuthStatus({
      available: true,
      loggedIn: false,
      detail: detail || "grok models failed; not logged in or not ready",
      source: "models-probe"
    });
  }

  // `grok models` exits 0 whether or not the CLI is authenticated, and prints the
  // model roster in both states, so exit status and the presence of "available
  // models" cannot distinguish them. Detect the unauthenticated banner instead.
  const stdout = (result.stdout || "").trim();
  // `grok models` prints exactly one auth banner as its first line
  // (xai-grok-pager/src/models.rs): "You are not authenticated.",
  // "You are logged in with <host>.", "You are using XAI_API_KEY.",
  // "Model '<m>' is using its own API key.", or
  // "You are authenticated via deployment key.". Only the first one means
  // the CLI cannot make calls; the other four are all usable credentials.
  const notAuthenticated = /^You are not authenticated\.|not logged in|please log in/im.test(stdout);
  const authBanner =
    /^(You are logged in with |You are using XAI_API_KEY|Model '.*' is using its own API key|You are authenticated via deployment key)/im.exec(
      stdout
    );
  const authMethod = notAuthenticated
    ? null
    : authBanner
      ? authBanner[1].startsWith("You are logged in")
        ? "grok-cli"
        : "api-key"
      : "unknown";
  // An unrecognised banner (future CLI wording) stays loggedIn so the gate does
  // not block, but is reported as unverified.
  const loggedIn = !notAuthenticated;
  const verified = !notAuthenticated && authBanner !== null;
  return buildAuthStatus({
    available: true,
    loggedIn,
    detail: firstLine(stdout) || "grok models succeeded",
    source: "models-probe",
    authMethod,
    verified
  });
}

export function getGrokAuthStatus(cwd, options = {}) {
  const availability = getGrokAvailability(cwd, options);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null
    };
  }
  return runModelsProbe(cwd, { ...options, binary: availability.binary });
}

function firstLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

// `--output-format plain` concatenates every assistant text block of every turn
// with no separator, so the answer arrives glued to the narration before it:
// `...then finish with the verdict line.VERDICT: OK`. On any run that uses a
// tool, the flat `--output-format json` envelope does the same inside `.text`
// (grok 1.0.41). A consumer that takes either as the answer is handed narration
// with it, and one that searches it for the answer can match text the model
// never issued as one.
//
// `--output-format streaming-messages-json` keeps the message boundaries:
// NDJSON, one whole message per line, ending in a `result` event that says
// whether the run completed. The answer is the last text block of the last
// assistant message, a structural boundary rather than a search. Not the result
// event's `.result`, which joins the final message's text blocks the same way.
//
// Fails closed: a line that is not a JSON object, a missing or unsuccessful
// result event, or a final message without text yields no answer and a stated
// reason. It never falls back to an earlier message, whose text is narration. A
// weld inside a single block is returned whole; splitting it would be a search.
export function answerFromMessageStream(stdout) {
  const refuse = (error) => ({ ok: false, text: "", error });
  const stream = completedMessageStream(stdout);
  if (!stream.ok) {
    return refuse(stream.error);
  }
  const final = stream.events.findLast((event) => event.type === "assistant");
  if (!final) {
    return refuse("grok output has no assistant message");
  }
  const content = Array.isArray(final.message?.content) ? final.message.content : [];
  const texts = content.filter((block) => block?.type === "text" && typeof block.text === "string");
  const answer = texts.length ? texts[texts.length - 1].text : "";
  if (!answer.trim()) {
    return refuse("grok's final message has no text");
  }
  return { ok: true, text: answer, error: "" };
}

// With --json-schema the result event carries the object the model was held
// to, as `structured_output`. That is the structured answer. It is read there
// and nowhere else: the final message may hold no text at all, and its text,
// when present, is the same weld-prone channel the schema exists to avoid.
export function structuredOutputFromMessageStream(stdout) {
  const refuse = (error) => ({ ok: false, value: null, error });
  const stream = completedMessageStream(stdout);
  if (!stream.ok) {
    return refuse(stream.error);
  }
  const value = stream.events[stream.events.length - 1].structured_output;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return refuse("grok's result event has no structured_output object");
  }
  return { ok: true, value, error: "" };
}

// Every line a JSON object, the last one a successful result event.
function completedMessageStream(stdout) {
  const refuse = (error) => ({ ok: false, events: [], error });
  if (typeof stdout !== "string" || !stdout.trim()) {
    return refuse("grok produced no output");
  }
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return refuse("grok output is not a message stream: a line is not JSON");
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      return refuse("grok output is not a message stream: a line is not a JSON object");
    }
    events.push(event);
  }
  const terminal = events[events.length - 1];
  if (terminal.type !== "result") {
    return refuse("grok output ends without a result event; the run did not complete");
  }
  if (terminal.subtype !== "success" || terminal.is_error) {
    return refuse(`grok run did not succeed (subtype: ${terminal.subtype}, is_error: ${terminal.is_error})`);
  }
  return { ok: true, events, error: "" };
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

function listRules(value) {
  if (value == null || value === "") {
    return [];
  }
  const rules = Array.isArray(value) ? value : [value];
  return rules.map((rule) => {
    const text = String(rule);
    if (!text.trim()) {
      throw new Error("Permission rules passed to the Grok CLI must not be blank.");
    }
    return text;
  });
}

function buildHeadlessArgs(prompt, options = {}) {
  const args = [];

  if (options.resumeSessionId) {
    args.push("-r", options.resumeSessionId);
  } else if (options.continueLast) {
    args.push("-c");
  } else if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }

  args.push("-p", prompt);

  if (options.cwd) {
    args.push("--cwd", options.cwd);
  }
  if (options.agent) {
    args.push("--agent", options.agent);
  }
  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }
  if (options.maxTurns != null) {
    args.push("--max-turns", String(options.maxTurns));
  }
  for (const rule of listRules(options.allow)) {
    args.push("--allow", rule);
  }
  for (const rule of listRules(options.deny)) {
    args.push("--deny", rule);
  }
  if (options.sandbox) {
    args.push("--sandbox", options.sandbox);
  }
  if (options.alwaysApprove) {
    args.push("--always-approve");
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }
  if (options.outputFormat) {
    args.push("--output-format", options.outputFormat);
  } else {
    args.push("--output-format", "plain");
  }
  if (options.jsonSchema) {
    const schemaText =
      typeof options.jsonSchema === "string" ? options.jsonSchema : JSON.stringify(options.jsonSchema);
    args.push("--json-schema", schemaText);
  }

  return args;
}

export function runHeadlessAgent(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const invocation = invocationFor(binary);
  const prompt = String(options.prompt ?? "").trim() || options.defaultPrompt || "";
  if (!prompt) {
    return Promise.reject(new Error("A prompt is required for this Grok run."));
  }

  const sessionId = options.resumeSessionId
    ? options.resumeSessionId
    : options.sessionId || (options.assignSessionId === false ? null : crypto.randomUUID());

  const args = buildHeadlessArgs(prompt, {
    ...options,
    cwd: options.cwd ?? cwd,
    sessionId: options.resumeSessionId || options.continueLast ? undefined : sessionId
  });

  const platform = options.platform ?? process.platform;
  const detached = options.detached ?? platform !== "win32";

  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.prefix, ...args], {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached,
      windowsHide: true
    });

    const agentPid = child.pid ?? null;
    emitProgress(options.onProgress, `Running grok (${binary}).`, "starting", {
      threadId: sessionId,
      agentPid,
      pid: agentPid
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code, signal) => {
      const status = code ?? (signal ? 1 : 0);
      if (
        status !== 0 &&
        options.jsonSchema &&
        /unexpected argument ['"]?--json-schema['"]?/i.test(stderr)
      ) {
        emitProgress(
          options.onProgress,
          "Grok rejected --json-schema; retrying with prompt-embedded schema.",
          "retrying",
          { threadId: sessionId, agentPid }
        );
        const { jsonSchema: _omitted, ...fallbackOptions } = options;
        resolve(
          runHeadlessAgent(cwd, {
            ...fallbackOptions,
            // Without the schema, json would weld narration onto the answer;
            // the message stream keeps the review in a block of its own.
            outputFormat: "streaming-messages-json",
            sessionId: options.resumeSessionId || options.continueLast ? undefined : sessionId
          })
        );
        return;
      }
      emitProgress(
        options.onProgress,
        status === 0 ? "Grok finished." : `Grok exited with status ${status}.`,
        status === 0 ? "finalizing" : "failed",
        { threadId: sessionId, agentPid }
      );
      resolve({
        status,
        signal,
        stdout,
        stderr,
        sessionId,
        threadId: sessionId,
        agentPid,
        finalMessage: stdout.trimEnd(),
        args,
        binary
      });
    });
  });
}

export function runImport(cwd, options = {}) {
  const binary = options.binary ?? resolveGrokBinary(options.env ?? process.env);
  const args = ["import"];
  if (options.list) {
    args.push("--list");
  }
  if (options.sourcePath) {
    args.push(options.sourcePath);
  }
  if (options.json !== false) {
    args.push("--json");
  }

  emitProgress(options.onProgress, "Importing Claude session into Grok.", "transferring");

  const result = runGrok(args, {
    cwd,
    env: options.env,
    binary
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || `exit ${result.status}`).trim();
    throw new Error(detail || "grok import failed");
  }

  const raw = (result.stdout || "").trim();
  let parsed = null;
  let sessionId = null;

  const lines = raw.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      parsed = obj;
      sessionId =
        obj.sessionId ??
        obj.session_id ??
        obj.id ??
        obj.importedSessionId ??
        obj.threadId ??
        sessionId;
    } catch {
    }
  }

  if (!sessionId) {
    const match = raw.match(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i);
    if (match) {
      sessionId = match[0];
    }
  }

  emitProgress(options.onProgress, sessionId ? `Imported session ${sessionId}.` : "Import completed.", "completed", {
    threadId: sessionId
  });

  return {
    status: 0,
    stdout: raw,
    stderr: result.stderr,
    sessionId,
    threadId: sessionId,
    parsed,
    resumeCommand: sessionId ? `grok -r ${sessionId}` : null
  };
}

export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      ...fallback,
      parsed: null,
      parseError: fallback.failureMessage ?? "Grok did not return a final structured message.",
      rawOutput: rawOutput ?? ""
    };
  }

  const text = String(rawOutput).trim();

  try {
    return {
      ...fallback,
      parsed: JSON.parse(text),
      parseError: null,
      rawOutput: text
    };
  } catch {
  }

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return {
        ...fallback,
        parsed: JSON.parse(fenced[1].trim()),
        parseError: null,
        rawOutput: text
      };
    } catch (error) {
      return {
        ...fallback,
        parsed: null,
        parseError: error.message,
        rawOutput: text
      };
    }
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return {
        ...fallback,
        parsed: JSON.parse(text.slice(start, end + 1)),
        parseError: null,
        rawOutput: text
      };
    } catch (error) {
      return {
        ...fallback,
        parsed: null,
        parseError: error.message,
        rawOutput: text
      };
    }
  }

  return {
    ...fallback,
    parsed: null,
    parseError: "Could not parse structured JSON from Grok output.",
    rawOutput: text
  };
}

export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export function schemaInstructionsFromPath(schemaPath) {
  if (!schemaPath || !fs.existsSync(schemaPath)) {
    return "";
  }
  const schema = readJsonFile(schemaPath);
  return [
    "Return only valid JSON matching this schema:",
    "```json",
    JSON.stringify(schema, null, 2),
    "```"
  ].join("\n");
}

export function buildReviewPrompt({ targetLabel, focusText, collectionGuidance, reviewInput, schemaInstructions = "" }) {
  const parts = [
    "You are performing a careful code review of the repository changes described below.",
    `Target: ${targetLabel}`,
    focusText ? `User focus: ${focusText}` : "User focus: none",
    "",
    "Rules:",
    "- Review only; do not modify files.",
    "- Prefer material findings over style nits.",
    "- Ground every finding in the provided context or read-only inspection.",
    collectionGuidance || "Use the repository context below as primary evidence.",
    "",
    reviewInput || "(no context)",
    schemaInstructions ? `\n${schemaInstructions}` : ""
  ];
  return parts.filter((line) => line !== undefined).join("\n");
}
