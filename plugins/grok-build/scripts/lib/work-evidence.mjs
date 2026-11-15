/**
 * Work-evidence assessment for Grok bridge runs (fleet#254).
 *
 * The bridge previously treated "the grok process exited 0" as "the delegate did the work".
 * A process exit code reports process health, never work completion: a run in which the model
 * emitted a one-sentence plan and ended its turn exits 0 exactly like a run that did the job.
 *
 * The Grok CLI already computes the discriminating signal, but only when asked for a structured
 * output format. `--output-format json` emits an envelope containing `num_turns`, `stopReason`
 * and `usage`. `num_turns === 1` means the model produced a single assistant turn with no tool
 * round-trip -- i.e. it described the work instead of doing it.
 *
 * These signals are computed by the CLI runtime, not authored by the model, so they cannot be
 * asserted away in prose. That is the property that makes them usable as a gate.
 */

/** Keys that identify a Grok headless JSON envelope rather than a schema-constrained payload. */
const ENVELOPE_KEYS = ["num_turns", "stopReason", "usage", "requestId"];

/**
 * Tolerantly split a headless stdout blob into assistant text plus run telemetry.
 *
 * Returns `telemetry: null` when stdout is not a JSON envelope (plain output format, or a
 * `--json-schema` run whose stdout is the schema payload itself). Callers must treat a null
 * telemetry as "unverified", never as "verified good".
 *
 * @param {string} stdout raw stdout from the grok headless process
 * @returns {{ text: string, telemetry: null | { numTurns: number|null, stopReason: string|null, outputTokens: number|null, totalTokens: number|null, modelCalls: number|null } }}
 */
export function extractRunTelemetry(stdout) {
  const text = typeof stdout === "string" ? stdout : "";
  const trimmed = text.trim();
  if (!trimmed || (trimmed[0] !== "{" && trimmed[0] !== "[")) {
    return { text: text.trimEnd(), telemetry: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { text: text.trimEnd(), telemetry: null };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { text: text.trimEnd(), telemetry: null };
  }

  const looksLikeEnvelope = ENVELOPE_KEYS.some((key) => Object.hasOwn(parsed, key));
  if (!looksLikeEnvelope) {
    // A schema-constrained payload. Preserve the original bytes so structured parsing still works.
    return { text: text.trimEnd(), telemetry: null };
  }

  const usage = parsed.usage && typeof parsed.usage === "object" ? parsed.usage : {};
  let modelCalls = null;
  if (parsed.modelUsage && typeof parsed.modelUsage === "object") {
    for (const entry of Object.values(parsed.modelUsage)) {
      if (entry && typeof entry.modelCalls === "number") {
        modelCalls = (modelCalls ?? 0) + entry.modelCalls;
      }
    }
  }

  const envelopeText = typeof parsed.text === "string" ? parsed.text : text.trimEnd();

  return {
    text: envelopeText,
    telemetry: {
      numTurns: typeof parsed.num_turns === "number" ? parsed.num_turns : null,
      stopReason: typeof parsed.stopReason === "string" ? parsed.stopReason : null,
      outputTokens: typeof usage.output_tokens === "number" ? usage.output_tokens : null,
      totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : null,
      modelCalls
    }
  };
}

/**
 * Decide whether a finished run carries positive evidence that work happened.
 *
 * Three outcomes, deliberately distinct:
 *  - `noWork: true`      proof of no work (a tool-free single turn). Terminal status must be failed.
 *  - `unverified: true`  the run produced no telemetry, so nothing is known. Surfaced loudly,
 *                        and failed only under `strict`.
 *  - neither             positive evidence of at least one tool round-trip.
 *
 * Duration is deliberately NOT a gate. A short run can be a correct answer to a small question,
 * and a duration floor converts this false-success into a false-failure -- the same
 * invert-the-error trade this fix exists to avoid. Duration is recorded for forensics only.
 *
 * @param {object} args
 * @param {ReturnType<typeof extractRunTelemetry>["telemetry"]} args.telemetry
 * @param {string} [args.text]
 * @param {number|null} [args.durationMs]
 * @param {boolean} [args.requireWork] enforce the gate at all (default true)
 * @param {boolean} [args.strict] also fail when telemetry is unavailable (default false)
 */
export function assessWorkEvidence({
  telemetry,
  text = "",
  durationMs = null,
  requireWork = true,
  strict = false
} = {}) {
  const evidence = {
    numTurns: telemetry?.numTurns ?? null,
    stopReason: telemetry?.stopReason ?? null,
    outputTokens: telemetry?.outputTokens ?? null,
    modelCalls: telemetry?.modelCalls ?? null,
    outputChars: typeof text === "string" ? text.trim().length : 0,
    durationMs,
    telemetryAvailable: Boolean(telemetry)
  };

  if (!requireWork) {
    return { noWork: false, unverified: false, reasons: [], evidence, enforced: false };
  }

  const reasons = [];

  if (!telemetry || telemetry.numTurns === null) {
    reasons.push(
      "No run telemetry was returned, so it cannot be shown that the delegate did any work."
    );
    return { noWork: strict, unverified: true, reasons, evidence, enforced: true };
  }

  if (telemetry.numTurns <= 1) {
    reasons.push(
      `The delegate produced ${telemetry.numTurns} assistant turn and made no tool calls: it described the task instead of performing it.`
    );
  }

  if (evidence.outputChars === 0) {
    reasons.push("The delegate returned no output text.");
  }

  return { noWork: reasons.length > 0, unverified: false, reasons, evidence, enforced: true };
}

/**
 * Human-readable banner appended to the rendered result so a caller reading only the
 * rendered text cannot miss an empty run.
 */
export function renderWorkEvidenceBanner(verdict) {
  if (!verdict || !verdict.enforced) {
    return "";
  }
  if (verdict.noWork) {
    return [
      "",
      "!! EMPTY RUN -- NO WORK PERFORMED (fleet#254 guard) !!",
      ...verdict.reasons.map((reason) => `- ${reason}`),
      "This run is marked FAILED. Do not treat its output as a result.",
      ""
    ].join("\n");
  }
  if (verdict.unverified) {
    return [
      "",
      "!! UNVERIFIED RUN -- no work telemetry available (fleet#254 guard) !!",
      ...verdict.reasons.map((reason) => `- ${reason}`),
      "Completion status is not evidence that the task was performed.",
      ""
    ].join("\n");
  }
  return "";
}
