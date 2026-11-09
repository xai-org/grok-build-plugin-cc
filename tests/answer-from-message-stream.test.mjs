import assert from "node:assert/strict";
import test from "node:test";

import { answerFromMessageStream } from "../plugins/grok-build/scripts/lib/grok.mjs";

const text = (value) => ({ type: "text", text: value });
const assistant = (...content) => ({ type: "assistant", message: { role: "assistant", content } });
const DONE = { type: "result", subtype: "success", is_error: false, result: "VERDICT: REVISE" };
const stream = (...events) => events.map((event) => JSON.stringify(event)).join("\n") + "\n";

const NARRATION = "I'll read the three diffs first, then the tests around them.";
const REASONING = "The user wants a review of three files. I should read the diffs first.";
const ANSWER = "VERDICT: REVISE\n\nThe glue refusal is the right call.";

// The shape `--output-format streaming-messages-json` emits for an agentic
// run: narration and a tool call in one message, the tool result, then the
// answer in a message of its own, then the terminal result event.
const STREAM = stream(
  { type: "system", subtype: "init", session_id: "s" },
  assistant({ type: "thinking", thinking: REASONING }, text(NARRATION), { type: "tool_use", id: "c1", name: "read_file", input: {} }),
  { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] } },
  assistant(text(ANSWER)),
  DONE
);

// What `--output-format json` returns for the same kind of run on grok 1.0.41:
// `.text` joins the narration and the answer with no separator.
const WELDED_ENVELOPE = JSON.stringify({
  text: "I'll read notes.txt with the file tool, then finish with the required verdict line.VERDICT: OK",
  stopReason: "end_turn",
  thought: REASONING
});

// `--output-format plain`: the same weld, as a human stream.
const GLUED_PLAIN_STREAM =
  "I'll review only those three files, starting with the branch diffs so the " +
  "verdict is based on the actual changes.VERDICT: REVISE\n\nThe glue refusal " +
  "is the right call.\n";

test("the answer is the last text block of the last assistant message", () => {
  const result = answerFromMessageStream(STREAM);
  assert.equal(result.ok, true);
  assert.equal(result.error, "");
  assert.equal(result.text, ANSWER);
  assert.equal(result.text.split("\n")[0], "VERDICT: REVISE");
});

test("narration from an earlier turn never reaches the answer", () => {
  assert.ok(!answerFromMessageStream(STREAM).text.includes(NARRATION));
});

test("reasoning never reaches the answer", () => {
  assert.ok(!answerFromMessageStream(STREAM).text.includes(REASONING));
});

test("an earlier block in the final message is not the answer", () => {
  const result = answerFromMessageStream(stream(assistant(text(NARRATION), text(ANSWER)), DONE));
  assert.equal(result.ok, true);
  assert.equal(result.text, ANSWER);
});

test("a weld inside one block is returned whole, never searched", () => {
  // A model that narrates and answers in a single block has failed the
  // contract. Splitting the block would mean searching prose for the answer.
  const welded = "I checked the diff.VERDICT: OK";
  const result = answerFromMessageStream(stream(assistant(text(welded)), DONE));
  assert.equal(result.ok, true);
  assert.equal(result.text, welded);
});

test("the welded json envelope is refused", () => {
  const result = answerFromMessageStream(WELDED_ENVELOPE);
  assert.equal(result.ok, false);
  assert.equal(result.text, "");
});

test("a glued plain stream is refused, not searched", () => {
  const result = answerFromMessageStream(GLUED_PLAIN_STREAM);
  assert.equal(result.ok, false);
  assert.equal(result.text, "");
});

test("the answer never falls back to an earlier message's text", () => {
  // The last assistant message carries no text. The text before it is
  // narration, and handing it back would be the original bug.
  const result = answerFromMessageStream(
    stream(assistant(text(NARRATION)), assistant({ type: "tool_use", id: "c2", name: "read_file", input: {} }), DONE)
  );
  assert.equal(result.ok, false);
  assert.equal(result.text, "");
});

test("a run that did not complete is refused even when it holds an answer", () => {
  const cases = {
    "no terminal event": stream(assistant(text(ANSWER))),
    "terminal event not last": stream(assistant(text(ANSWER)), DONE, assistant(text(ANSWER))),
    "error subtype": stream(assistant(text(ANSWER)), { ...DONE, subtype: "error_max_turns" }),
    "is_error set": stream(assistant(text(ANSWER)), { ...DONE, is_error: true })
  };
  for (const [name, input] of Object.entries(cases)) {
    const result = answerFromMessageStream(input);
    assert.equal(result.ok, false, `${name} must not be ok`);
    assert.equal(result.text, "", `${name} must yield no answer`);
    assert.ok(result.error.length > 0, `${name} must say why`);
  }
});

test("every unusable shape fails closed with an empty answer", () => {
  const cases = {
    "empty string": "",
    "whitespace only": "   \n\t ",
    "not a string": undefined,
    "null": null,
    "a line that is not json": stream(assistant(text(ANSWER))) + "not json\n" + JSON.stringify(DONE),
    "a line that is not an object": stream(assistant(text(ANSWER))) + "[1]\n" + JSON.stringify(DONE),
    "no assistant message": stream({ type: "system", subtype: "init" }, DONE),
    "final text is empty": stream(assistant(text("  \n ")), DONE),
    "final text is not a string": stream(assistant({ type: "text", text: ["VERDICT: OK"] }), DONE),
    "message without content": stream({ type: "assistant", message: { role: "assistant" } }, DONE)
  };
  for (const [name, input] of Object.entries(cases)) {
    const result = answerFromMessageStream(input);
    assert.equal(result.ok, false, `${name} must not be ok`);
    assert.equal(result.text, "", `${name} must yield no answer`);
    assert.ok(result.error.length > 0, `${name} must say why`);
  }
});
