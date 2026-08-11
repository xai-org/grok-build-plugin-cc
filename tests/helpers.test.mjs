import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { makeTempDir, writeExecutable } from "./helpers.mjs";

const SOURCE = "#!/usr/bin/env node\nprocess.stdout.write(\"fake\\n\");\n";

test("writeExecutable installs a .cmd shim on Windows so PATHEXT can find the script", () => {
  const scriptPath = path.join(makeTempDir(), "grok");

  writeExecutable(scriptPath, SOURCE, { platform: "win32" });

  assert.equal(fs.readFileSync(scriptPath, "utf8"), SOURCE);
  assert.equal(fs.readFileSync(`${scriptPath}.cmd`, "utf8"), '@echo off\r\nnode "%~dp0grok" %*\r\n');
});

test("writeExecutable writes no shim on posix", () => {
  const scriptPath = path.join(makeTempDir(), "grok");

  writeExecutable(scriptPath, SOURCE, { platform: "linux" });

  assert.equal(fs.existsSync(`${scriptPath}.cmd`), false);
});
