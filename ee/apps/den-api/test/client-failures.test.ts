import assert from "node:assert/strict"
import { test } from "node:test"
import { z } from "zod"
import { clientFailureBatchSchema, clientFailureReportSchema } from "@openwork/types/den/diagnostics"

const report = {
  schemaVersion: 1, reportId: "e15770b8-a7a1-4ac8-87be-1e19a856905a", occurredAt: "2026-11-16T10:00:00.000Z",
  component: "engine", phase: "start", reason: "exit_nonzero", appVersion: "1.2.3-dev", platform: "darwin", arch: "arm64", exitCode: 1, count: 1,
}
test("strict fixed-schema report and batch bounds", () => {
  assert.deepEqual(clientFailureReportSchema.parse(report), report)
  assert.equal(clientFailureBatchSchema.safeParse({ reports: [report] }).success, true)
  for (const reports of [[], Array.from({ length: 51 }, () => report)]) assert.equal(clientFailureBatchSchema.safeParse({ reports }).success, false)
  for (const key of ["message", "stack", "path", "url", "hostname", "connector", "server", "model", "provider", "prompt", "toolArguments", "organizationId"]) {
    assert.equal(clientFailureReportSchema.safeParse({ ...report, [key]: "private" }).success, false, key)
  }
  for (const [key, value] of Object.entries({ component: "private", phase: "install", reason: "private", appVersion: "private", platform: "other", arch: "private", count: 1001, httpStatus: 600, exitCode: 1000, schemaVersion: 2 })) {
    assert.equal(clientFailureReportSchema.safeParse({ ...report, [key]: value }).success, false, key)
  }
})

function assertConstrainedStrings(value: unknown): void {
  if (!value || typeof value !== "object") return
  if ("type" in value && value.type === "string") {
    const versionPattern = "pattern" in value && value.pattern === String.raw`^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$`
    assert.ok("enum" in value || "const" in value || versionPattern || ("format" in value && (value.format === "uuid" || value.format === "date-time")), JSON.stringify(value))
  }
  for (const child of Object.values(value)) assertConstrainedStrings(child)
}
test("every report string is an enum, literal, uuid, timestamp or version pattern", () => {
  assertConstrainedStrings(z.toJSONSchema(clientFailureReportSchema))
  assert.throws(() => assertConstrainedStrings(z.toJSONSchema(z.strictObject({ message: z.string() }))))
  assert.throws(() => assertConstrainedStrings(z.toJSONSchema(z.strictObject({ message: z.string().max(64) }))))
  assert.throws(() => assertConstrainedStrings(z.toJSONSchema(z.strictObject({ message: z.string().regex(/.*/) }))))
})
