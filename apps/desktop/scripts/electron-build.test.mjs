import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { test } from "node:test";

for (const prebuilt of [false, true]) {
  test(`desktop stages compiled runtime modules with a ${prebuilt ? "prebuilt" : "clean"} server`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "desktop-build-order-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    function write(file, code = "") {
      const path = join(root, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, code, { mode: 0o755 });
    }
    const fixtures = "apps/desktop/scripts";
    const build = join(root, fixtures, "electron-build.mjs");
    write(`${fixtures}/electron-build.mjs`);
    copyFileSync(new URL("./electron-build.mjs", import.meta.url), build);
    write(`${fixtures}/prepare-server-constants.mjs`, "export function prepareServerConstants() {}");
    for (const script of ["prepare-runtime-node-modules.test", "prepare-packaged-sandbox-image.test", "packaged-runtime-dependencies.test", "packaged-native-signing.test", "prepare-sidecar", "prepare-computer-use-helper", "prepare-dictation-helper", "prepare-packaged-sandbox-image", "prepare-desktop-free-release", "check-electron-bridge"]) {
      write(`${fixtures}/${script}.mjs`);
    }
    write("apps/desktop/electron/entry.mjs");
    write("apps/server/package.json", "{}");
    write("apps/server/dist/index.js");
    const compiled = "packages/computers/dist/index.js";
    if (prebuilt) write(compiled);
    const fakePnpm = join(root, "bin", "pnpm");
    write("bin/pnpm", `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("openwork-server")) {
  if (${prebuilt}) throw new Error("Unexpected rebuild with --server-built");
  fs.mkdirSync("packages/computers/dist", { recursive: true });
  fs.writeFileSync(${JSON.stringify(compiled)}, "export const fixture = true;");
}
`);
    if (process.platform === "win32") write("bin/pnpm.cmd", `@node "${fakePnpm}" %*\r\n`);
    write(`${fixtures}/prepare-runtime-node-modules.mjs`, `
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const compiled = fileURLToPath(new URL("../../../${compiled}", import.meta.url));
const staged = resolve(process.argv[process.argv.indexOf("--outdir") + 1], "@openwork/computers/dist/index.js");
mkdirSync(dirname(staged), { recursive: true });
copyFileSync(compiled, staged);
`);
    write("apps/server/scripts/build-opencode-plugin-deps.mjs");
    const result = spawnSync(process.execPath, [build, ...(prebuilt ? ["--server-built"] : [])], {
      cwd: root,
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, PATH: `${join(root, "bin")}${delimiter}${process.env.PATH}` },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.ok(existsSync(join(root, "apps/desktop/.electron-runtime/node_modules/@openwork/computers/dist/index.js")));
  });
}
