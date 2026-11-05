import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { collectReviewContext, resolveReviewTarget } from "../plugins/grok-build/scripts/lib/git.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

// A committed repo with a nested package directory, sitting on main.
function makeRepoWithSubdirectory() {
  const cwd = makeTempDir();
  initGitRepo(cwd);
  fs.mkdirSync(path.join(cwd, "packages", "web"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "packages", "web", "index.js"), "export {};\n");
  fs.writeFileSync(path.join(cwd, "README.md"), "# repo\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "init"], { cwd });
  return { root: cwd, subdir: path.join(cwd, "packages", "web") };
}

test("auto scope from a subdirectory sees an untracked file elsewhere in the repo", () => {
  const { root, subdir } = makeRepoWithSubdirectory();
  fs.writeFileSync(path.join(root, "new-at-root.js"), "console.log('new');\n");

  const target = resolveReviewTarget(subdir, {});
  assert.equal(target.mode, "working-tree");

  const context = collectReviewContext(subdir, target);
  assert.deepEqual(context.changedFiles, ["new-at-root.js"]);
});

test("auto scope from a subdirectory sees an untracked file in a sibling directory", () => {
  const { root, subdir } = makeRepoWithSubdirectory();
  fs.mkdirSync(path.join(root, "packages", "api"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "api", "server.js"), "console.log('api');\n");

  const target = resolveReviewTarget(subdir, {});
  assert.equal(target.mode, "working-tree");
});

test("auto scope from a subdirectory still sees an untracked file inside that subdirectory", () => {
  const { subdir } = makeRepoWithSubdirectory();
  fs.writeFileSync(path.join(subdir, "extra.js"), "console.log('extra');\n");

  const target = resolveReviewTarget(subdir, {});
  assert.equal(target.mode, "working-tree");
  assert.deepEqual(collectReviewContext(subdir, target).changedFiles, ["packages/web/extra.js"]);
});

test("auto scope from a subdirectory of a clean repo still picks the branch diff", () => {
  const { subdir } = makeRepoWithSubdirectory();

  const target = resolveReviewTarget(subdir, {});
  assert.equal(target.mode, "branch");
  assert.equal(target.baseRef, "main");
});
