import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext, resolveReviewTarget } from "../plugins/grok-build/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function commitFile(cwd, name, content, message) {
  fs.writeFileSync(path.join(cwd, name), content);
  run("git", ["add", name], { cwd });
  run("git", ["commit", "-m", message], { cwd });
}

// An upstream repo with main and a feature branch.
function makeUpstream() {
  const upstream = makeTempDir();
  initGitRepo(upstream);
  commitFile(upstream, "app.js", "console.log('base');\n", "base");
  run("git", ["checkout", "-b", "feature/test"], { cwd: upstream });
  commitFile(upstream, "app.js", "console.log('feature');\n", "feature");
  run("git", ["checkout", "main"], { cwd: upstream });
  return upstream;
}

// A clone that sits on feature/test and has origin/HEAD -> origin/main but no local main,
// as left by `git clone --branch feature/test` or after deleting the local main.
function cloneFeatureOnly(upstream) {
  const parent = makeTempDir();
  const clone = path.join(parent, "clone");
  const cloned = run("git", ["clone", "--branch", "feature/test", upstream, clone]);
  assert.equal(cloned.status, 0, cloned.stderr);
  assert.notEqual(run("git", ["show-ref", "--verify", "--quiet", "refs/heads/main"], { cwd: clone }).status, 0);
  assert.equal(
    run("git", ["symbolic-ref", "refs/remotes/origin/HEAD"], { cwd: clone }).stdout.trim(),
    "refs/remotes/origin/main"
  );
  return clone;
}

test("--scope branch compares against origin/<default> when there is no local default branch", () => {
  const clone = cloneFeatureOnly(makeUpstream());

  const target = resolveReviewTarget(clone, { scope: "branch" });
  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "origin/main");

  const context = collectReviewContext(clone, target);
  assert.deepEqual(context.changedFiles, ["app.js"]);
  assert.match(context.content, /feature/);
});

test("auto scope on a clean tree compares against origin/<default> when there is no local default branch", () => {
  const clone = cloneFeatureOnly(makeUpstream());

  const target = resolveReviewTarget(clone, {});
  assert.equal(target.mode, "branch");
  assert.equal(target.explicit, false);
  assert.equal(target.baseRef, "origin/main");
  assert.doesNotThrow(() => collectReviewContext(clone, target));
});

test("a local default branch is still preferred over origin/<default>", () => {
  const clone = cloneFeatureOnly(makeUpstream());
  run("git", ["branch", "main", "origin/main"], { cwd: clone });

  const target = resolveReviewTarget(clone, { scope: "branch" });
  assert.equal(target.baseRef, "main");
});

test("an origin/HEAD that points at a deleted remote branch falls back to the usual candidates", () => {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  commitFile(cwd, "app.js", "console.log('base');\n", "base");
  run("git", ["update-ref", "refs/remotes/origin/main", "main"], { cwd });
  run("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/gone"], { cwd });
  run("git", ["checkout", "-b", "feature/test"], { cwd });
  commitFile(cwd, "app.js", "console.log('feature');\n", "feature");

  const target = resolveReviewTarget(cwd, { scope: "branch" });
  assert.equal(target.baseRef, "main");
  assert.deepEqual(collectReviewContext(cwd, target).changedFiles, ["app.js"]);
});
