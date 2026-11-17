import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { operationalDiagnosticSnapshotSchema, operationalDiagnosticsConfigSchema, bucketOperationalUptime } from "../src/operational-diagnostics.ts";

const snapshot = {
  schemaVersion: 1,
  version: "0.0.0-dev",
  instanceKind: "den-api",
  deploymentKind: "self_hosted",
  uptimeSeconds: "0-299",
  snapshotTime: "2026-11-16T12:00:00.000Z",
  components: { database: "ok", migrations: "unknown", worker: "unknown", engine: "unknown", localServer: "unknown" },
};

test("accepts only the fixed snapshot shape", () => {
  assert.deepEqual(operationalDiagnosticSnapshotSchema.parse(snapshot), snapshot);
  assert.equal(operationalDiagnosticSnapshotSchema.safeParse({ ...snapshot, extra: true }).success, false);
  assert.equal(operationalDiagnosticSnapshotSchema.safeParse({ ...snapshot, components: { ...snapshot.components, extra: "ok" } }).success, false);
  for (const field of ["orgId", "userId", "memberId", "installId", "deviceId", "sessionId", "requestId", "hostname", "ip", "url", "path", "email", "model", "provider", "connector", "people", "organizations", "message", "error"]) {
    assert.equal(operationalDiagnosticSnapshotSchema.safeParse({ ...snapshot, [field]: "forbidden" }).success, false, field);
    assert.equal(operationalDiagnosticSnapshotSchema.safeParse({ ...snapshot, components: { ...snapshot.components, [field]: "forbidden" } }).success, false, field);
  }
});

test("rejects unbounded or unrecognised string schemas anywhere in the snapshot", () => {
  const schema = z.toJSONSchema(operationalDiagnosticSnapshotSchema);
  const permittedPatterns = {
    "properties.version": /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.source,
    "properties.snapshotTime": /^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:00\.000Z$/.source,
  };
  function visit(node, location = "") {
    if (!node || typeof node !== "object") return;
    if (node.type === "string") {
      assert.ok(Array.isArray(node.enum) || typeof node.const === "string" || (Object.hasOwn(permittedPatterns, location) && node.pattern === permittedPatterns[location]), location);
    }
    for (const [key, value] of Object.entries(node)) visit(value, location ? `${location}.${key}` : key);
  }
  visit(schema);
});

test("version and minute timestamp cannot contain arbitrary content", () => {
  for (const version of ["dev", "commit 123abcd", "https://example.invalid", "1.2.3\nextra"]) {
    assert.equal(operationalDiagnosticSnapshotSchema.safeParse({ ...snapshot, version }).success, false);
  }
  for (const snapshotTime of ["2026-11-16T12:00:01.000Z", "2026-11-16T12:00:00.001Z", "2026-11-16T99:00:00.000Z"]) {
    assert.equal(operationalDiagnosticSnapshotSchema.safeParse({ ...snapshot, snapshotTime }).success, false);
  }
  assert.deepEqual([0, 300, 3600, 86400].map(bucketOperationalUptime), ["0-299", "300-3599", "3600-86399", "86400+"]);
});

test("diagnostics configuration is strict, bounded and off by default", () => {
  assert.deepEqual(operationalDiagnosticsConfigSchema.parse({}), { enabled: false, output: "stdout", intervalMinutes: 60 });
  for (const invalid of [{ enabled: "true" }, { output: true }, { destination: "remote" }, { intervalMinutes: 4 }, { intervalMinutes: 1441 }, { intervalMinutes: 5.5 }]) {
    assert.equal(operationalDiagnosticsConfigSchema.safeParse(invalid).success, false);
  }
});
