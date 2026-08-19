import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "@openwork/testkit";
import { expect } from "vitest";

import { isEngineConnectionFailure } from "../../apps/server/src/engine-pool";
import { createManagedOpencodeServer } from "../../apps/server/src/managed-opencode";
import { captureServerException } from "../../apps/server/src/telemetry";

test("server error boundaries contain expected noise without hiding actionable failures", async ({ evidence }) => {
  const originalTelemetry = globalThis.__openworkDesktopTelemetry;
  const captured: unknown[] = [];
  const request = new AbortController();
  const cancellation = new DOMException("The operation was aborted", "AbortError");
  const unrelatedError = new TypeError("fetch failed");
  request.abort(cancellation);

  try {
    globalThis.__openworkDesktopTelemetry = {
      captureException(error) {
        captured.push(error);
        return true;
      },
    };

    expect(captureServerException(cancellation, { requestSignal: request.signal })).toBe(false);
    expect(captured).toEqual([]);
    evidence.recordAssertionEvidence(
      "Positive: request-owned aborts stay out of server telemetry",
      "An aborted request carrying its AbortError returned false and delivered zero exceptions to the telemetry host.",
      true,
    );

    expect(captureServerException(unrelatedError, { requestSignal: request.signal })).toBe(true);
    expect(captured).toEqual([unrelatedError]);
    evidence.recordAssertionEvidence(
      "Negative: unrelated server errors remain observable",
      "A TypeError unrelated to the already-aborted request returned true and was the sole captured exception.",
      true,
    );
  } finally {
    globalThis.__openworkDesktopTelemetry = originalTelemetry;
  }

  expect(isEngineConnectionFailure(new TypeError("fetch failed"))).toBe(true);
  expect(isEngineConnectionFailure(new Error("fetch failed"))).toBe(false);
  evidence.recordAssertionEvidence(
    "Cause-less loopback fetch failures retain a narrow transport type",
    "The engine transport classifier accepted a cause-less TypeError('fetch failed') while rejecting the same message on a plain Error.",
    true,
  );

  const root = await mkdtemp(join(tmpdir(), "openwork-server-boundaries-"));
  const attemptsPath = join(root, "attempts.log");
  const bin = join(root, "unknown-code-one.mjs");
  await writeFile(bin, [
    "#!/usr/bin/env bun",
    "import { appendFileSync } from 'node:fs';",
    "appendFileSync(process.env.ATTEMPTS_PATH, 'start\\n');",
    "console.log('startup diagnostics from stdout');",
    "console.error('fatal provider configuration mismatch');",
    "process.exit(1);",
  ].join("\n"));
  await chmod(bin, 0o755);

  try {
    let failure: unknown;
    try {
      await createManagedOpencodeServer({ bin, cwd: root, env: { ATTEMPTS_PATH: attemptsPath } });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("Expected managed OpenCode startup to fail");
    expect(failure.message).toContain("OpenCode server exited with code 1");
    expect(failure.message).toContain("startup diagnostics from stdout");
    expect(failure.message).toContain("fatal provider configuration mismatch");
    expect((await readFile(attemptsPath, "utf8")).trim().split("\n")).toEqual(["start"]);
    evidence.recordAssertionEvidence(
      "Unknown code-1 startup failures stay actionable and bounded",
      "A non-EADDRINUSE code-1 exit ran once, rejected with its exit code, and retained diagnostics from both stdout and stderr.",
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
