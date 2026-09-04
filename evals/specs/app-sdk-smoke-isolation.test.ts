import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const repoRoot = resolve(import.meta.dirname, "../..");

test("the app SDK smoke suite keeps a poisoned parent environment out of every smoke engine", ({ evidence }) => {
  const poisonRoot = mkdtempSync(join(tmpdir(), "openwork-app-sdk-smoke-poison-"));
  try {
    const poisonedConfig = join(poisonRoot, "opencode.json");
    const xdgConfigHome = join(poisonRoot, "xdg");
    const xdgOpencodeDir = join(xdgConfigHome, "opencode");
    mkdirSync(xdgOpencodeDir, { recursive: true });
    writeFileSync(poisonedConfig, '{ "poisoned":');
    writeFileSync(join(xdgOpencodeDir, "opencode.jsonc"), '{ "poisoned":');

    const result = spawnSync("pnpm", [
      "--filter",
      "@openwork/app",
      "test:e2e",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 90_000,
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        OPENCODE_CONFIG: poisonedConfig,
        XDG_CONFIG_HOME: xdgConfigHome,
      },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.error, output).toBeUndefined();
    expect(result.status, output).toBe(0);
    expect(output).not.toContain('"ok": false');
    expect(output).not.toContain('"status": "error"');
    expect(output).toContain('"name": "path.get"');
    expect(output).toContain('"name": "session.messages switch"');
    expect(output).toContain('"root":".openwork/test-engine"');
    expect(output).toContain('"name": "assert.built-in-browser-quickstart"');

    evidence.recordAssertionEvidence(
      "A poisoned parent environment does not reach any core SDK smoke engine",
      "With poisoned OPENCODE_CONFIG and XDG_CONFIG_HOME values, the exact app test:e2e command completes core health/path/session/prompt/todo/SSE, session switching, filesystem operations, and the browser-entry project command with no error report.",
      true,
    );
  } finally {
    rmSync(poisonRoot, { recursive: true, force: true });
  }
});
