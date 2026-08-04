import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext, resolveReviewTarget } from "../plugins/grok-build/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

test("resolveReviewTarget prefers working tree when repo is dirty", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");

  const target = resolveReviewTarget(cwd, {});

  assert.equal(target.mode, "working-tree");
});

test("resolveReviewTarget falls back to branch diff when repo is clean", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.match(target.label, /main/);
  assert.match(context.content, /Branch Diff/);
});

test("default branch names with special characters are passed to git literally", () => {
  const cwd = makeTempDir();
  const branchName = "main&branch-helper&x";
  const helperOutputPath = path.join(cwd, "branch-helper-output");
  initGitRepo(cwd);
  // Windows-style batch helper; if shell expansion occurs, running it writes this marker.
  fs.writeFileSync(path.join(cwd, "branch-helper.cmd"), "@echo branch-helper>branch-helper-output\r\n");
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('base');\n");
  run("git", ["add", "app.js", "branch-helper.cmd"], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  run("git", ["branch", "-m", branchName], { cwd, shell: false });
  run("git", ["update-ref", `refs/remotes/origin/${branchName}`, branchName], { cwd, shell: false });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${branchName}`], {
    cwd,
    shell: false
  });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('feature');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });

  const target = resolveReviewTarget(cwd, {});
  const context = collectReviewContext(cwd, target);

  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, branchName);
  assert.match(context.content, /Branch Diff/);
  assert.equal(fs.existsSync(helperOutputPath), false);
});

test("resolveReviewTarget honors explicit base overrides", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v1');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "console.log('v2');\n");
  run("git", ["add", "app.js"], { cwd });
  run("git", ["commit", "-m", "change"], { cwd });

  const target = resolveReviewTarget(cwd, { base: "main" });
  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
  assert.equal(target.explicit, true);
});
