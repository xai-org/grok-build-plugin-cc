import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "GROK_CC_TRANSCRIPT_PATH";

// Claude Code keeps transcripts under `<config dir>/projects`, where the config
// dir is `$CLAUDE_CONFIG_DIR` when set and `~/.claude` otherwise. Both roots are
// accepted so a session saved before the variable was set can still be imported.
function claudeProjectsDirs() {
  const dirs = [path.join(os.homedir(), ".claude", "projects")];
  const configDir = process.env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) {
    dirs.unshift(path.join(resolveUserPath(process.cwd(), configDir), "projects"));
  }
  return [...new Set(dirs)];
}

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const requestedPath = options.source || process.env[TRANSCRIPT_PATH_ENV];
  if (!requestedPath) {
    throw new Error("Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.");
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source;
  try {
    source = fs.realpathSync(sourcePath);
  } catch {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }
  const allowed = claudeProjectsDirs();
  for (const dir of allowed) {
    let projects;
    try {
      projects = fs.realpathSync(dir);
    } catch {
      continue;
    }
    const relative = path.relative(projects, source);
    if (relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      return source;
    }
  }
  throw new Error(`Grok can import Claude sessions only from ${allowed.join(" or ")}: ${source}`);
}
