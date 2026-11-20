/**
 * Tests for the log-output safety guards in log-utils.ts:
 *   - truncateLogLine caps oversized records so process.stdout.write never
 *     hits Node's Buffer allocation limit.
 *   - isUnavailableLogOutputError treats RangeError as a suppressible I/O
 *     error so it never propagates as an unhandled exception.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { truncateLogLine, isUnavailableLogOutputError } from "../src/log-utils.js";

const TWO_MIB = 2 * 1024 * 1024;

// ---------------------------------------------------------------------------
// truncateLogLine
// ---------------------------------------------------------------------------

test("truncateLogLine returns short lines unchanged", () => {
  const line = "hello world";
  assert.equal(truncateLogLine(line), line);
});

test("truncateLogLine returns lines exactly at 2 MiB unchanged", () => {
  // All ASCII: byteLength === string length.
  const exactly = "y".repeat(TWO_MIB);
  assert.equal(truncateLogLine(exactly), exactly);
});

test("truncateLogLine truncates lines that exceed 2 MiB and appends marker", () => {
  const huge = "x".repeat(TWO_MIB + 100);
  const result = truncateLogLine(huge);
  assert.ok(result.length < huge.length, "result should be shorter than input");
  assert.ok(result.endsWith(" [LOG TRUNCATED]"), "result should end with marker");
  assert.ok(
    Buffer.byteLength(result, "utf8") <= TWO_MIB + 50,
    "truncated result must be within safe byte budget (plus marker overhead)",
  );
});

// ---------------------------------------------------------------------------
// isUnavailableLogOutputError
// ---------------------------------------------------------------------------

test("isUnavailableLogOutputError returns true for RangeError", () => {
  assert.equal(isUnavailableLogOutputError(new RangeError("Failed to allocate memory")), true);
});

test("isUnavailableLogOutputError returns true for known IO error codes", () => {
  for (const code of ["EPIPE", "ERR_STREAM_DESTROYED", "ENOSPC", "EDQUOT", "EIO"]) {
    const err = Object.assign(new Error(code), { code });
    assert.equal(isUnavailableLogOutputError(err), true, `expected true for code ${code}`);
  }
});

test("isUnavailableLogOutputError returns false for unknown error codes", () => {
  assert.equal(
    isUnavailableLogOutputError(Object.assign(new Error("oops"), { code: "EACCES" })),
    false,
  );
});

test("isUnavailableLogOutputError returns false for non-object values", () => {
  for (const v of [null, undefined, "EPIPE", 42, true]) {
    assert.equal(isUnavailableLogOutputError(v), false, `expected false for ${String(v)}`);
  }
});
