import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const subjects = [
  "apps/desktop/electron/updater.mjs",
  "apps/desktop/electron/updater.test.mjs",
  "apps/desktop/electron/preload.mjs",
  "apps/app/src/app/lib/desktop.ts",
  "apps/app/src/i18n/locales/en.ts",
  "apps/app/src/react-app/domains/settings/state/electron-updater-state.ts",
  "apps/app/src/react-app/domains/settings/state/desktop-updater-provider.tsx",
  "apps/app/src/react-app/domains/settings/pages/updates-view.tsx",
  "apps/app/tests/electron-updater-check-now.test.ts",
  "apps/app/tests/electron-updater-install-policy.test.ts",
  "apps/app/tests/version-gate.test.ts",
  "apps/app/src/app/lib/version-gate.ts",
];

export async function desktopUpdateRegressionsWorld() {
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 10_000 });
    if (result.error || result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.error?.message ?? result.stderr}`);
    return result.stdout.trim();
  };
  const identity = () => ({
    head: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain", "--", ...subjects),
    objects: git("hash-object", "--", ...subjects).split("\n"),
  });
  return {
    identity,
    subjects,
    run: (suite: "main" | "renderer") => {
      const reportDir = suite === "renderer" ? mkdtempSync(join(tmpdir(), "updater-regressions-")) : null;
      const args = suite === "main"
        ? ["exec", "node", "--test", "--test-reporter=tap", "--test-name-pattern=^(installAndRestart|downloaded update lifecycle|metadata-only updater checks|updater artifact metadata size|macOS native staging|release channel changes)( |$)", "apps/desktop/electron/updater.test.mjs"]
        : ["--dir", "apps/app", "exec", "bun", "test", "--isolate", "--reporter=junit", `--reporter-outfile=${reportDir}/results.xml`, "tests/electron-updater-check-now.test.ts", "tests/electron-updater-install-policy.test.ts", "tests/version-gate.test.ts"];
      const before = identity();
      const result = spawnSync("pnpm", args, {
        cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      });
      let report = "";
      if (reportDir) {
        try {
          report = readFileSync(join(reportDir, "results.xml"), "utf8");
        } finally {
          rmSync(reportDir, { recursive: true, force: true });
        }
      }
      const output = result.stdout + result.stderr + report;
      const count = (pattern: RegExp) => {
        const match = output.match(pattern);
        return match ? Number(match[1]) : null;
      };
      return {
        command: `pnpm ${args.map((arg) => JSON.stringify(arg)).join(" ")}`,
        before, after: identity(), output, status: result.status, signal: result.signal,
        error: result.error?.message,
        passed: count(suite === "main" ? /^# pass (\d+)$/m : /^\s*(\d+) pass\s*$/m),
        failed: count(suite === "main" ? /^# fail (\d+)$/m : /^\s*(\d+) fail\s*$/m),
        total: count(suite === "main" ? /^# tests (\d+)$/m : /Ran (\d+) tests? across/),
        skipped: suite === "main" ? count(/^# skipped (\d+)$/m) : count(/^\s*(\d+) skip\s*$/m) ?? 0,
        cancelled: suite === "main" ? count(/^# cancelled (\d+)$/m) : 0,
        todo: suite === "main" ? count(/^# todo (\d+)$/m) : count(/^\s*(\d+) todo\s*$/m) ?? 0,
      };
    },
  };
}
