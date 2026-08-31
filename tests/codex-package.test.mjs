import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CODEX_ROOT = path.join(ROOT, "codex");
const CODEX_PLUGIN = path.join(CODEX_ROOT, "plugins", "grok-build");
const CLAUDE_PLUGIN = path.join(ROOT, "plugins", "grok-build");

function read(relativePath) {
  return fs.readFileSync(path.join(CODEX_PLUGIN, relativePath), "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

const SHARED_FILES = [
  "prompts/critique.md",
  "schemas/review-output.schema.json",
  "scripts/lib/args.mjs",
  "scripts/lib/fs.mjs",
  "scripts/lib/git.mjs",
  "scripts/lib/process.mjs",
  "scripts/lib/prompts.mjs",
  "scripts/lib/workspace.mjs"
];

test("Codex marketplace points to the self-contained grok-build plugin", () => {
  const marketplace = readJson(path.join(CODEX_ROOT, ".agents", "plugins", "marketplace.json"));
  assert.equal(marketplace.name, "barscn-grok-build");
  assert.equal(marketplace.interface.displayName, "Grok Build for Codex");
  assert.deepEqual(marketplace.plugins, [{
    name: "grok-build",
    source: { source: "local", path: "./plugins/grok-build" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity"
  }]);
});

test("Codex manifest uses the approved identity and version", () => {
  const manifest = readJson(path.join(CODEX_PLUGIN, ".codex-plugin", "plugin.json"));
  assert.equal(manifest.name, "grok-build");
  assert.equal(manifest.version, "0.2.1+codex.1");
  assert.equal(manifest.author.name, "barscn");
  assert.equal(manifest.license, "Apache-2.0");
  assert.equal(manifest.repository, "https://github.com/barscn/grok-build-plugin");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(Object.hasOwn(manifest, "hooks"), false);
  assert.equal(Object.hasOwn(manifest, "apps"), false);
  assert.equal(Object.hasOwn(manifest, "mcpServers"), false);
  assert.ok(manifest.interface.defaultPrompt.length <= 3);
});

test("Codex package excludes Claude-only surfaces", () => {
  for (const relativePath of ["commands", "agents", "hooks", "scripts/session-lifecycle-hook.mjs", "scripts/lib/claude-session-transfer.mjs"]) {
    assert.equal(fs.existsSync(path.join(CODEX_PLUGIN, relativePath)), false, relativePath);
  }
  assert.equal(fs.existsSync(path.join(CODEX_PLUGIN, "skills", "grok-build", "SKILL.md")), true);
});

test("explicitly shared files match the Claude package byte-for-byte", () => {
  for (const relativePath of SHARED_FILES) {
    assert.deepEqual(
      fs.readFileSync(path.join(CODEX_PLUGIN, relativePath)),
      fs.readFileSync(path.join(CLAUDE_PLUGIN, relativePath)),
      relativePath
    );
  }
});

test("Codex package contains no Claude slash-command strings", () => {
  const stack = [CODEX_PLUGIN];
  const matches = [];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      const text = fs.readFileSync(fullPath, "utf8");
      if (text.includes("/grok-build:")) {
        matches.push(path.relative(CODEX_PLUGIN, fullPath));
      }
    }
  }
  assert.deepEqual(matches, []);
});
