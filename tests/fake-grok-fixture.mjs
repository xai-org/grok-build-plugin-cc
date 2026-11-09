import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { writeExecutable } from "./helpers.mjs";

/**
 * Install a fake `grok` binary that responds to version/models/-p/import for hermetic tests.
 * @param {string} binDir directory that will be prepended to PATH
 * @param {"default"|"not-logged-in"|"not-authenticated"|"fail-print"|"import-ok"|"reject-json-schema"|"reject-json-schema-narration"|"reject-json-schema-array"|"schema-no-text"|"schema-no-structured"|"schema-wrong-shape"|"stop-hook-fails"|"api-key"|"deployment-key"} scenario
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
  if (scenario === "not-authenticated") {
    // Mirrors grok CLI 1.0.3: exits 0 and still prints the roster when logged out.
    process.stdout.write("You are not authenticated.\\n\\nDefault model: fake-model\\n\\nAvailable models:\\n  - fake-model\\n");
    process.exit(0);
  }
  if (scenario === "api-key") {
    process.stdout.write("You are using XAI_API_KEY.\\n\\nDefault model: fake-model\\n\\nAvailable models:\\n  - fake-model\\n");
    process.exit(0);
  }
  if (scenario === "deployment-key") {
    process.stdout.write("You are authenticated via deployment key.\\n\\nDefault model: fake-model\\n\\nAvailable models:\\n  - fake-model\\n");
    process.exit(0);
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
  if (scenario.startsWith("reject-json-schema") && hasFlag("--json-schema")) {
    process.stderr.write("error: unexpected argument '--json-schema' found\\n");
    process.stderr.write("Usage: grok --single <PROMPT> --cwd <CWD> --agent <NAME> --sandbox <PROFILE> --always-approve --output-format <OUTPUT_FORMAT>\\n");
    process.exit(2);
  }
  // Three output shapes, and the differences are the whole point. Each one is
  // modelled on grok 1.0.41 as observed, because a fake that is kinder than the
  // CLI passes code the CLI breaks.
  //   --json-schema        constrains the model to the schema. It does not
  //                        change the format: the object is carried beside the
  //                        text, as .structuredOutput on the json envelope and
  //                        as .structured_output on the stream's result event.
  //   --output-format json one envelope, reasoning under .thought. Its .text
  //                        joins every assistant text block of every turn with
  //                        no separator, so narration arrives welded to the
  //                        answer, exactly as in plain.
  //   --output-format streaming-messages-json
  //                        NDJSON, one whole message per line, then a terminal
  //                        result event. The answer is the last text block of
  //                        the last assistant message.
  // The shape follows the flags, never the prompt: a prompt that embeds a
  // schema (the fallback when --json-schema is rejected) is not answered at
  // the root.
  const wantsSchema = hasFlag("--json-schema");
  const format = flagValue("--output-format");
  // What an agent says before it uses a tool. It is not the answer.
  const narration = "I'll look at the request before answering.";

  let answer;
  let structured;
  if (wantsSchema || /critique|adversarial|structured|Return only valid JSON/i.test(prompt)) {
    const payload = {
      verdict: "approve",
      summary: "No material issues found in the reviewed changes.",
      findings: [],
      next_steps: ["Ship it."]
    };
    answer = JSON.stringify(payload) + "\\n";
    if (wantsSchema) {
      // Valid JSON, wrong shape: the schema has no say over what the bridge validates.
      structured = scenario === "schema-wrong-shape" ? { summary: "No verdict here." } : payload;
    }
    if (scenario === "reject-json-schema-array") {
      // Parses, and is not a review object.
      answer = "[]\\n";
    }
    if (scenario === "reject-json-schema-narration") {
      // An unconstrained model narrating around an example of the shape.
      answer = "I read the diff. A review would look like " + JSON.stringify(payload) + " but I have concerns.\\n";
    }
  } else if (/stop-gate review|ALLOW:|BLOCK:/i.test(prompt)) {
    answer = "ALLOW: previous turn did not make code changes\\n";
  } else if (/code review|Review the provided repository|Reviewing/i.test(prompt) || hasFlag("--agent")) {
    answer = "Reviewed uncommitted changes.\\nNo material issues found.\\n";
  } else {
    answer = "Handled the requested task.\\n";
  }

  const sessionId = "00000000-0000-4000-8000-000000000000";
  const reasoning = "fake grok reasoning that must never reach the answer";
  if (format === "json") {
    process.stdout.write(
      JSON.stringify({
        text: narration + answer.trimEnd(),
        stopReason: "end_turn",
        sessionId,
        thought: reasoning,
        usage: { input_tokens: 1, output_tokens: 1 },
        ...(structured ? { structuredOutput: structured } : {})
      }) + "\\n"
    );
  } else if (format === "streaming-messages-json") {
    const events = [
      { type: "system", subtype: "init", session_id: sessionId },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: reasoning },
            { type: "text", text: narration },
            { type: "tool_use", id: "call-1", name: "read_file", input: {} }
          ]
        },
        session_id: sessionId
      },
      {
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok", is_error: false }] },
        session_id: sessionId
      },
      {
        type: "assistant",
        message: {
          role: "assistant",
          // A structured run's final frame can carry no text block at all.
          content: scenario === "schema-no-text" ? [{ type: "thinking", thinking: reasoning }] : [{ type: "text", text: answer.trimEnd() }]
        },
        session_id: sessionId
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: scenario === "schema-no-text" ? "" : answer.trimEnd(),
        session_id: sessionId,
        ...(structured && scenario !== "schema-no-structured" ? { structured_output: structured } : {})
      }
    ];
    process.stdout.write(events.map((event) => JSON.stringify(event)).join("\\n") + "\\n");
  } else {
    process.stdout.write(answer);
  }
  if (scenario === "stop-hook-fails") {
    // The run completed and reported success, then a Stop hook failed it.
    process.stderr.write("Stop hook failed\\n");
    process.exit(1);
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
