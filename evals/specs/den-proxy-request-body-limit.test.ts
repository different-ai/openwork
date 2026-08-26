import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { test } from "@openwork/testkit";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

test("the Den Web proxy bounds request bodies and rejects oversized ones before contacting Den", async ({ evidence }) => {
  const unit = spawnSync("pnpm", [
    "--dir",
    "ee/apps/den-web",
    "exec",
    "bun",
    "--conditions=development",
    "test",
    "app/api/_lib/upstream-proxy.test.mjs",
  ], { cwd: repoRoot, encoding: "utf8" });
  const output = `${unit.stdout}${unit.stderr}`;
  expect(unit.error, output).toBeUndefined();
  expect(unit.status, output).toBe(0);
  expect(output).toContain(" 23 pass");
  expect(output).toContain(" 0 fail");

  evidence.recordAssertionEvidence(
    "Oversized request bodies are rejected with structured 413 responses and Den is never contacted",
    "The proxy suite passed: declared and chunked oversized bodies returned request_too_large with request ids and CORS headers while the upstream server observed zero requests, bodies at and immediately below the limit proxied byte-for-byte, ordinary multipart uploads continued, and rejection logs carried sizes without credentials or file contents.",
    true,
  );
});
