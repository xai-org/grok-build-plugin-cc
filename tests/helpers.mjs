import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

export function makeTempDir(prefix = "grok-build-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeExecutable(filePath, source, options = {}) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });

  // Windows resolves a bare command name through PATHEXT, which never matches
  // an extensionless file, so the script stays invisible on PATH and the real
  // binary is found instead. Write a .cmd shim beside it, the way npm ships
  // npm and npm.cmd. Callers must keep spawning the bare name: spawn rejects a
  // literal .bat/.cmd path unless shell is set (CVE-2024-27980).
  if ((options.platform ?? process.platform) === "win32") {
    const script = path.basename(filePath);
    fs.writeFileSync(`${filePath}.cmd`, `@echo off\r\nnode "%~dp0${script}" %*\r\n`, { encoding: "utf8" });
  }
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Grok Build Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
