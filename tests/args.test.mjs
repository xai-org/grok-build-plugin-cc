import test from "node:test";
import assert from "node:assert/strict";

import { parseArgs, splitRawArgumentString } from "../plugins/grok-build/scripts/lib/args.mjs";

test("parseArgs handles value, boolean, and alias options", () => {
  const result = parseArgs(["--cwd", "/tmp", "--json", "-m", "model-x", "remaining"], {
    valueOptions: ["cwd", "model"],
    booleanOptions: ["json"],
    aliasMap: { m: "model" }
  });

  assert.deepEqual(result.options, {
    cwd: "/tmp",
    json: true,
    model: "model-x"
  });
  assert.deepEqual(result.positionals, ["remaining"]);
});

test("splitRawArgumentString respects quotes and escapes", () => {
  const tokens = splitRawArgumentString(`review --base main "focus on auth" keep\\ going`);
  assert.deepEqual(tokens, ["review", "--base", "main", "focus on auth", "keep going"]);
});

test("parseArgs collects repeated allow and deny rules", () => {
  const result = parseArgs(
    ["--allow", "Bash(npm test)", "--allow=Bash(grep *)", "--deny", "Edit(generated/**)", "do the task"],
    {
      repeatableOptions: ["allow", "deny"]
    }
  );

  assert.deepEqual(result.options.allow, ["Bash(npm test)", "Bash(grep *)"]);
  assert.deepEqual(result.options.deny, ["Edit(generated/**)"]);
  assert.deepEqual(result.positionals, ["do the task"]);
});

test("parseArgs throws when a value option is missing its value", () => {
  assert.throws(
    () =>
      parseArgs(["--model"], {
        valueOptions: ["model"]
      }),
    /Missing value for --model/
  );
});

test("parseArgs can warn on unknown long options without treating them as positionals", () => {
  const result = parseArgs(["--scpoe", "working-tree", "focus text"], {
    valueOptions: ["scope"],
    unknownMode: "warn"
  });
  assert.deepEqual(result.unknown, ["--scpoe"]);
  assert.deepEqual(result.positionals, ["working-tree", "focus text"]);
  assert.equal(result.options.scope, undefined);
});
