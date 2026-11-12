import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../../../", import.meta.url);

test("device sharing loads in plain Node from the packaged node_modules layout", (t) => {
  // Workspace symlinks resolve outside node_modules, where Node can strip types.
  // Copy the real package so this catches the packaged app's stricter boundary.
  const fixture = mkdtempSync(join(tmpdir(), "openwork-packaged-types-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const installed = join(fixture, "node_modules", "@openwork", "types");
  mkdirSync(installed, { recursive: true });
  for (const name of ["package.json", "src", "dist"]) {
    cpSync(new URL(`packages/types/${name}`, root), join(installed, name), { recursive: true });
  }
  cpSync(realpathSync(new URL("packages/types/node_modules/zod", root)), join(fixture, "node_modules", "zod"), { recursive: true });
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import { deviceShareOptionsSchema, deviceShareProviderName, parseDeviceShareProviderIds } from "@openwork/types/den/device-provider-share";
    assert.match(import.meta.resolve("@openwork/types/den/device-provider-share"), /\\/dist\\/den\\/device-provider-share\\.js$/);
    assert.equal(deviceShareProviderName(" Fixture ", "fixture"), "Fixture");
    assert.deepEqual(parseDeviceShareProviderIds("fixture,fixture,other"), ["fixture", "other"]);
    assert.equal(deviceShareOptionsSchema.parse({
      canShare: false, blocker: "no_permission", managerName: null,
      verificationRequired: false, providers: [],
    }).canShare, false);
  `], { cwd: fixture, encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" } });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
