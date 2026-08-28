import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "@openwork/testkit";
import { expect } from "vitest";

const updaterUnitTest = fileURLToPath(new URL("../../apps/desktop/electron/updater.test.mjs", import.meta.url));
const updaterInstallErrorTest = fileURLToPath(new URL(
  "../../apps/app/src/react-app/domains/settings/state/electron-updater-install-error.test.ts",
  import.meta.url,
));

test("Linux AppImage updates stop before restart when the install directory is not writable", async ({ evidence }) => {
  const unit = spawnSync(process.execPath, [
    "--test",
    "--test-reporter=tap",
    updaterUnitTest,
  ], { encoding: "utf8" });

  expect(unit.status, unit.stderr || unit.stdout).toBe(0);
  expect(unit.stdout).toContain("blocks downloads when the AppImage directory lacks replacement permissions");
  expect(unit.stdout).toContain("rechecks AppImage permissions before restarting after download");
  expect(unit.stdout).toContain("blocks recovery before downloading or restarting from an unwritable directory");
  expect(unit.stdout).toContain("rechecks recovery permissions after download before restarting");
  expect(unit.stdout).not.toContain("not ok");
  expect(unit.stdout).toMatch(/# fail 0\b/);

  const renderer = spawnSync("bun", ["test", "--isolate", updaterInstallErrorTest], { encoding: "utf8" });
  const rendererOutput = `${renderer.stdout}${renderer.stderr}`;
  expect(renderer.status, rendererOutput).toBe(0);
  expect(rendererOutput).toContain("maps a native AppImage permission reason to the visible install error state");

  evidence.recordAssertionEvidence(
    "Unwritable AppImage locations do not trigger a doomed restart",
    "The updater returns actionable copy-or-download guidance that maps to the visible install error state, keeps automatic install-on-quit disabled for AppImages, and avoids download or restart when the AppImage parent directory cannot be replaced. It rechecks immediately before restart for both normal and updater-backed recovery installs.",
    true,
  );
});
