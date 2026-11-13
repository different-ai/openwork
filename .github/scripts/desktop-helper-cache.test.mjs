import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// Run the actual build entry point and helper scripts with tiny native compiler
// fixtures. Stop at the first workspace build; no Swift SDK or install is needed.
function fixture(body) {
  const root = mkdtempSync(join(tmpdir(), "desktop-helper-cache-"));
  const scripts = join(root, "apps/desktop/scripts");
  const bin = join(root, "bin");
  const calls = join(root, "calls.jsonl");
  const native = join(root, "packages/computer-use/native");
  const dictation = join(root, "apps/desktop/native/dictation");
  for (const dir of [scripts, bin, join(native, "Sources/ComputerUse"), dictation]) mkdirSync(dir, { recursive: true });
  for (const name of ["electron-build.mjs", "prepare-computer-use-helper.mjs", "prepare-dictation-helper.mjs", "prepare-server-constants.mjs"]) {
    copyFileSync(new URL(`../../apps/desktop/scripts/${name}`, import.meta.url), join(scripts, name));
  }
  writeFileSync(join(scripts, "prepare-sidecar.mjs"), "");
  writeFileSync(join(native, "Package.swift"), "// fixture package");
  const computerSource = join(native, "Sources/ComputerUse/main.swift");
  writeFileSync(computerSource, "// fixture computer use");
  for (const name of ["main.swift", "audio-input.swift", "transcript.swift", "speech-analyzer.swift"]) {
    writeFileSync(join(dictation, name), "// fixture dictation");
  }
  const preload = join(root, "platform.cjs");
  writeFileSync(preload, 'Object.defineProperty(process, "platform", { value: "darwin" });');
  const tool = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const name = path.basename(process.argv[1]);
const args = process.argv.slice(2);
fs.appendFileSync(process.env.NATIVE_TEST_CALLS, JSON.stringify({ name, args }) + "\\n");
if (name === "pnpm") process.exit(86);
if (name === "security") process.exit(1);
if (name === "xcrun") console.log("26.5");
if (name === "swift") {
  const built = path.join(process.env.NATIVE_TEST_ROOT, "compiled");
  if (args.includes("--show-bin-path")) console.log(built);
  else {
    fs.mkdirSync(built, { recursive: true });
    fs.writeFileSync(path.join(built, "ComputerUse"), "fixture executable");
  }
}
if (name === "swiftc") fs.writeFileSync(args[args.indexOf("-o") + 1], "fixture dictation executable");
`;
  for (const name of ["pnpm", "swift", "swiftc", "codesign", "security", "xcrun"]) {
    writeFileSync(join(bin, name), tool, { mode: 0o755 });
  }
  const run = (reuse = "true") => {
    writeFileSync(calls, "");
    const result = spawnSync(process.execPath, [join(scripts, "electron-build.mjs")], {
      encoding: "utf8", timeout: 20_000,
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`,
        NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
        OPENWORK_REUSE_NATIVE_HELPERS: reuse, OPENWORK_COMPUTER_USE_FORCE_BUILD: "",
        NATIVE_TEST_ROOT: root, NATIVE_TEST_CALLS: calls,
      },
    });
    assert.equal(result.status, 86, result.stderr || result.stdout);
    return readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line))
      .filter(call => call.name === "swiftc" || (call.name === "swift" && !call.args.includes("--show-bin-path")))
      .map(call => call.name);
  };
  try { body({ root, run, computerSource, dictation }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("desktop helper reuse builds cold, skips warm and rebuilds changed or missing outputs", () => {
  fixture(({ root, run, computerSource, dictation }) => {
    assert.deepEqual(run(), ["swift", "swiftc"]);
    assert.deepEqual(run(), [], "a warm build must not invoke either compiler");
    writeFileSync(computerSource, "// changed computer use");
    assert.deepEqual(run(), ["swift"]);
    writeFileSync(join(dictation, "audio-input.swift"), "// changed audio input");
    assert.deepEqual(run(), ["swiftc"]);
    rmSync(join(root, "apps/desktop/resources/helpers/OpenWork Computer Use.app/Contents/MacOS/ComputerUse"));
    rmSync(join(root, "apps/desktop/resources/helpers/openwork-dictation"));
    assert.deepEqual(run(), ["swift", "swiftc"]);
    assert.deepEqual(run(""), ["swift"], "ordinary builds retain their forced computer-use rebuild");
  });
});
