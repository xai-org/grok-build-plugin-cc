import assert from "node:assert/strict";
import test from "node:test";

import {
  assessWorkEvidence,
  extractRunTelemetry,
  renderWorkEvidenceBanner
} from "../plugins/grok-build/scripts/lib/work-evidence.mjs";

// The exact envelope shape emitted by `grok -p ... --output-format json`, captured from the
// real CLI on 2026-08-06 (grok-4.5-build). num_turns === 1 is a tool-free single turn.
const EMPTY_RUN_ENVELOPE = JSON.stringify({
  text: "I'll run an adversarial review of PR #250 in isolation: fetch the PR/issue, clone the branch under /tmp, then attack the six claimed risk areas with concrete evidence only.",
  stopReason: "end_turn",
  sessionId: "019fd6fd-828e-7de3-bb52-61347d34dc03",
  requestId: "ab9f08dc-8c9e-4f6d-b697-fb6e6bfcdd49",
  usage: { input_tokens: 20400, output_tokens: 77, total_tokens: 51453 },
  num_turns: 1,
  total_cost_usd: 0.05,
  modelUsage: { "grok-4.5-build": { modelCalls: 1 } }
});

const REAL_RUN_ENVELOPE = JSON.stringify({
  text: "## Directory inventory\n| Path | Type |\n...\nVERDICT: DO_NOT_MERGE",
  stopReason: "end_turn",
  usage: { input_tokens: 20400, output_tokens: 472, total_tokens: 60000 },
  num_turns: 3,
  modelUsage: { "grok-4.5-build": { modelCalls: 3 } }
});

test("extractRunTelemetry recovers num_turns and text from a headless JSON envelope", () => {
  const { text, telemetry } = extractRunTelemetry(EMPTY_RUN_ENVELOPE);
  assert.equal(telemetry.numTurns, 1);
  assert.equal(telemetry.stopReason, "end_turn");
  assert.equal(telemetry.outputTokens, 77);
  assert.equal(telemetry.modelCalls, 1);
  assert.match(text, /^I'll run an adversarial review/);
});

test("extractRunTelemetry leaves plain output untouched and reports no telemetry", () => {
  const { text, telemetry } = extractRunTelemetry("Handled the requested task.\n");
  assert.equal(telemetry, null);
  assert.equal(text, "Handled the requested task.");
});

test("extractRunTelemetry does not mistake a --json-schema payload for an envelope", () => {
  const payload = JSON.stringify({ verdict: "approve", findings: [], summary: "fine" });
  const { text, telemetry } = extractRunTelemetry(payload);
  assert.equal(telemetry, null, "schema payloads carry no run telemetry");
  assert.equal(text, payload, "schema payload bytes must survive for structured parsing");
});

test("fleet#254: an intent-only run is proven empty and must not pass", () => {
  const { text, telemetry } = extractRunTelemetry(EMPTY_RUN_ENVELOPE);
  const verdict = assessWorkEvidence({ telemetry, text, durationMs: 7215 });
  assert.equal(verdict.noWork, true);
  assert.equal(verdict.unverified, false);
  assert.equal(verdict.evidence.numTurns, 1);
  assert.match(verdict.reasons.join(" "), /described the task instead of performing it/);
  assert.match(renderWorkEvidenceBanner(verdict), /EMPTY RUN/);
});

test("a run with tool round-trips passes", () => {
  const { text, telemetry } = extractRunTelemetry(REAL_RUN_ENVELOPE);
  const verdict = assessWorkEvidence({ telemetry, text, durationMs: 268056 });
  assert.equal(verdict.noWork, false);
  assert.equal(verdict.unverified, false);
  assert.equal(renderWorkEvidenceBanner(verdict), "");
});

test("a fast but genuine run is NOT failed — duration is never a gate", () => {
  // run-msgdxv4t-g9mcvz answered a four-command question correctly in 3.4s. A duration floor
  // would invert this fix's error, turning a false success into a false failure.
  const envelope = JSON.stringify({
    text: "1. /home/psimmons/worktrees/ops-plans-a7\n2. clean\n3. abc123\n4. main",
    stopReason: "end_turn",
    usage: { output_tokens: 40 },
    num_turns: 2
  });
  const { text, telemetry } = extractRunTelemetry(envelope);
  const verdict = assessWorkEvidence({ telemetry, text, durationMs: 3391 });
  assert.equal(verdict.noWork, false, "short duration alone must never fail a run");
});

test("missing telemetry is reported as unverified, never as verified-good", () => {
  const verdict = assessWorkEvidence({ telemetry: null, text: "Handled the requested task." });
  assert.equal(verdict.unverified, true);
  assert.equal(verdict.noWork, false, "unknown is not proof of absence by default");
  assert.match(renderWorkEvidenceBanner(verdict), /UNVERIFIED RUN/);
});

test("strict mode fails an unverifiable run", () => {
  const verdict = assessWorkEvidence({ telemetry: null, text: "ok", strict: true });
  assert.equal(verdict.noWork, true);
});

test("--allow-no-work disables the gate entirely for genuine tool-free analysis", () => {
  const { text, telemetry } = extractRunTelemetry(EMPTY_RUN_ENVELOPE);
  const verdict = assessWorkEvidence({ telemetry, text, requireWork: false });
  assert.equal(verdict.noWork, false);
  assert.equal(verdict.enforced, false);
  assert.equal(renderWorkEvidenceBanner(verdict), "");
});
