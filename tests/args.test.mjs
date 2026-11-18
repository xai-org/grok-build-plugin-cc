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

test("parseArgs keeps the full inline value when it contains '='", () => {
  const result = parseArgs(["--base=feature=exp", "--url=https://x/?a=b&c=d"], {
    valueOptions: ["base", "url"]
  });
  assert.equal(result.options.base, "feature=exp");
  assert.equal(result.options.url, "https://x/?a=b&c=d");
});

test("parseArgs still handles a plain and an empty inline value", () => {
  const result = parseArgs(["--base=main", "--note="], {
    valueOptions: ["base", "note"]
  });
  assert.equal(result.options.base, "main");
  assert.equal(result.options.note, "");
});

test("splitRawArgumentString keeps an explicitly-quoted empty argument", () => {
  assert.deepEqual(splitRawArgumentString(`send ""`), ["send", ""]);
  assert.deepEqual(splitRawArgumentString(`a "" b`), ["a", "", "b"]);
});
