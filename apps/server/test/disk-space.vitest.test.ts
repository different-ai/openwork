import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, test } from "vitest";
import { isDiskFullError, unexpectedApiError, watchDiskSpace, watchedDiskFreeMegabytes } from "../src/disk-space.js";
import { captureServerException, resetDiskFullReportsForTests, type ServerTelemetryContext } from "../src/telemetry.js";

function fsError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

/** A real "database or disk is full" from SQLite, by capping the database at four pages. */
function sqliteFullError(): unknown {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA page_size = 512; PRAGMA max_page_count = 4; CREATE TABLE notes (body TEXT)");
    const insert = db.prepare("INSERT INTO notes (body) VALUES (?)");
    for (let row = 0; row < 50; row += 1) insert.run("x".repeat(2000));
  } catch (error) {
    return error;
  } finally {
    db.close();
  }
  throw new Error("expected SQLite to run out of pages");
}

test("a full disk is recognised from the file system, from SQLite and through wrapping errors", () => {
  expect(isDiskFullError(fsError("ENOSPC", "ENOSPC: no space left on device, write"))).toBe(true);
  expect(isDiskFullError(fsError("EDQUOT", "EDQUOT: disk quota exceeded, write"))).toBe(true);
  expect(isDiskFullError(sqliteFullError())).toBe(true);
  // Bun's SQLite reports the same failure with its own code.
  expect(isDiskFullError(fsError("SQLITE_FULL", "database or disk is full"))).toBe(true);
  expect(isDiskFullError(new Error("OpenCode v2 did not start: ENOSPC: no space left on device, write"))).toBe(true);
  expect(isDiskFullError(new Error("Could not save settings", { cause: fsError("ENOSPC", "write failed") }))).toBe(true);
});

test("other failures are not mistaken for a full disk", () => {
  expect(isDiskFullError(new Error("unable to open database file"))).toBe(false);
  expect(isDiskFullError(fsError("EPERM", "EPERM: operation not permitted, open"))).toBe(false);
  expect(isDiskFullError(new Error("The connected service reported that its storage quota was exceeded"))).toBe(false);
  // Text from a command that ran somewhere else says nothing about this computer's disk.
  expect(isDiskFullError(new Error("Remote command failed: tar: write error: No space left on device"))).toBe(false);
  expect(isDiskFullError("ENOSPC")).toBe(false);
  expect(isDiskFullError(null)).toBe(false);
  const loop = new Error("first");
  loop.cause = new Error("second", { cause: loop });
  expect(isDiskFullError(loop)).toBe(false);
});

test("an unhandled full-disk failure answers 507 with what to do; anything else stays a generic 500", () => {
  const full = unexpectedApiError(sqliteFullError());
  expect([full.status, full.code]).toEqual([507, "insufficient_storage"]);
  expect(full.message).toBe("Not enough disk space. Free up space on the computer running OpenWork, then try again.");

  const other = unexpectedApiError(new Error("boom"));
  expect([other.status, other.code, other.message]).toEqual([500, "internal_error", "Unexpected server error"]);
});

type Report = { error: unknown; context: ServerTelemetryContext | undefined };
let reports: Report[] = [];
let directory = "";

beforeEach(() => {
  reports = [];
  resetDiskFullReportsForTests();
  directory = mkdtempSync(join(tmpdir(), "openwork-disk-space-"));
  watchDiskSpace(directory);
  globalThis.__openworkDesktopTelemetry = {
    captureException: (error, context) => {
      reports.push({ error, context });
      return true;
    },
  };
});

afterEach(() => {
  globalThis.__openworkDesktopTelemetry = undefined;
  rmSync(directory, { recursive: true, force: true });
});

test("the space left is read for a real folder and unknown for one that is gone", () => {
  expect(watchedDiskFreeMegabytes()).toBeGreaterThanOrEqual(0);
  watchDiskSpace(join(directory, "missing"));
  expect(watchedDiskFreeMegabytes()).toBeNull();
});

test("full-disk failures are reported once per interval as one grouped warning with the space left", () => {
  const route = { method: "POST", route: "/workspace/ws_1/mcp/openwork-cloud/reconcile" };

  expect(captureServerException(sqliteFullError(), route)).toBe(true);
  // The retries that follow, and other writes failing for the same reason, add nothing.
  expect(captureServerException(sqliteFullError(), route)).toBe(false);
  expect(captureServerException(fsError("ENOSPC", "ENOSPC: no space left on device, write"), { method: "PUT", route: "/env" })).toBe(false);

  expect(reports).toHaveLength(1);
  const context = reports[0]?.context;
  expect(context).toMatchObject({ surface: "server", ...route, fingerprint: ["disk-full"], level: "warning" });
  expect(context?.tags?.["disk.free_mb"]).toMatch(/^\d+$/);
});

test("other errors are reported every time, ungrouped", () => {
  expect(captureServerException(sqliteFullError(), { route: "/a" })).toBe(true);
  expect(captureServerException(new Error("boom"), { route: "/b" })).toBe(true);
  expect(captureServerException(new Error("boom"), { route: "/b" })).toBe(true);

  expect(reports).toHaveLength(3);
  expect(reports[1]?.context).toEqual({ surface: "server", route: "/b" });
});
