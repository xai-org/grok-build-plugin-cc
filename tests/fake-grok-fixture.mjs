import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

/**
 * Install a fake `grok` binary that responds to version/models/-p/import for hermetic tests.
 * @param {string} binDir directory that will be prepended to PATH
 * @param {"default"|"not-logged-in"|"fail-print"|"import-ok"} scenario
 */
export function installFakeGrok(binDir, scenario = "default") {
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "grok");

  const source = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const scenario = ${JSON.stringify(scenario)};
const argv = process.argv.slice(2);

function hasFlag(name) {
  return argv.includes(name);
}

function flagValue(name) {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function writeLog() {
  const logPath = process.env.FAKE_GROK_LOG;
  if (!logPath) return;
  fs.appendFileSync(logPath, JSON.stringify({ argv, scenario, cwd: process.cwd() }) + "\\n");
}

writeLog();

if (argv[0] === "version" || argv[0] === "--version" || argv[0] === "-V") {
  if (hasFlag("--json")) {
    process.stdout.write(JSON.stringify({ currentVersion: "0.2.83-fake", channel: "test" }) + "\\n");
  } else {
    process.stdout.write("grok 0.2.83-fake\\n");
  }
  process.exit(0);
}

if (argv[0] === "models") {
  if (scenario === "not-logged-in") {
    process.stderr.write("Not logged in. Run grok interactively to authenticate.\\n");
    process.exit(1);
  }
  process.stdout.write("You are logged in with grok.com.\\n\\nDefault model: fake-model\\n\\nAvailable models:\\n  - fake-model\\n");
  process.exit(0);
}

if (argv[0] === "import") {
  if (hasFlag("--list")) {
    if (hasFlag("--json")) {
      process.stdout.write(JSON.stringify({ sessions: [] }) + "\\n");
    } else {
      process.stdout.write("No sessions listed.\\n");
    }
    process.exit(0);
  }
  const target = argv.find((arg, i) => i > 0 && !arg.startsWith("-")) ?? "unknown";
  const sessionId = "11111111-2222-4333-8444-555555555555";
  if (hasFlag("--json")) {
    process.stdout.write(JSON.stringify({ sessionId, source: target, status: "imported" }) + "\\n");
  } else {
    process.stdout.write("Imported session " + sessionId + " from " + target + "\\n");
  }
  process.exit(0);
}

// Headless print / prompt modes
const printIndex = argv.indexOf("-p");
const isPrint = printIndex !== -1 || hasFlag("--print");
if (isPrint || hasFlag("-r") || hasFlag("--resume") || hasFlag("-c") || hasFlag("--continue")) {
  if (scenario === "fail-print") {
    process.stderr.write("fake grok failed the print run\\n");
    process.exit(2);
  }

  const prompt = printIndex !== -1 ? (argv[printIndex + 1] ?? "") : "";
  const wantsSchema = hasFlag("--json-schema");
  const wantsEnvelope = !wantsSchema && flagValue("--output-format") === "json";
  const wantsJson = wantsSchema || flagValue("--output-format") === "json";

  // fleet#254: the delegate path now asks for --output-format json, so the fake must emit the
  // real CLI's envelope (text + num_turns + usage). The "empty-run" scenario reproduces the
  // defect: a single tool-free turn that still exits 0.
  if (wantsEnvelope) {
    const emptyRun = scenario === "empty-run";
    const envelope = {
      text: emptyRun
        ? "I'll investigate the repository and report back with findings."
        : "Handled the requested task.",
      stopReason: "end_turn",
      sessionId: "11111111-2222-4333-8444-555555555555",
      usage: { input_tokens: 100, output_tokens: emptyRun ? 30 : 200, total_tokens: 300 },
      num_turns: emptyRun ? 1 : 3,
      modelUsage: { "fake-model": { modelCalls: emptyRun ? 1 : 3 } }
    };
    process.stdout.write(JSON.stringify(envelope) + "\\n");
    process.exit(0);
  }

  if (wantsJson || /critique|adversarial|structured|Return only valid JSON/i.test(prompt)) {
    const payload = {
      verdict: "approve",
      summary: "No material issues found in the reviewed changes.",
      findings: [],
      next_steps: ["Ship it."]
    };
    process.stdout.write(JSON.stringify(payload) + "\\n");
  } else if (/stop-gate review|ALLOW:|BLOCK:/i.test(prompt)) {
    process.stdout.write("ALLOW: previous turn did not make code changes\\n");
  } else if (/code review|Review the provided repository|Reviewing/i.test(prompt) || hasFlag("--agent")) {
    process.stdout.write("Reviewed uncommitted changes.\\nNo material issues found.\\n");
  } else {
    process.stdout.write("Handled the requested task.\\n");
  }
  process.exit(0);
}

process.stderr.write("fake grok: unknown invocation: " + argv.join(" ") + "\\n");
process.exit(1);
`;

  writeExecutable(scriptPath, source);
  return scriptPath;
}

export function buildEnv(binDir, extra = {}) {
  return {
    ...process.env,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
    ...extra
  };
}
