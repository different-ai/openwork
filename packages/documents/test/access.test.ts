import assert from "node:assert/strict"
import { test } from "node:test"
import { DocumentsError } from "../src/index"
import { documentsAccessFailure, DOCUMENT_RECOVERY_MS, lockDocumentRecovery, expiredDocumentRecovery } from "../src/access"

test("listing availability, connection recovery, revocation and feature state are separate facts", () => {
  assert.equal(documentsAccessFailure(new Error("offline")), null)
  assert.equal(documentsAccessFailure(new DocumentsError(503, "upstream_unavailable", "")), null)
  assert.equal(documentsAccessFailure(new DocumentsError(409, "needs_connection", "")), "connection")
  assert.equal(documentsAccessFailure(new DocumentsError(401, "unauthorized", "")), "signin")
  assert.equal(documentsAccessFailure(new DocumentsError(403, "permission_denied", "")), "blocked")
  assert.equal(documentsAccessFailure(new DocumentsError(409, "unknown_conflict", "")), "blocked")
  assert.equal(documentsAccessFailure(new DocumentsError(403, "feature_disabled", "")), "disabled")
  assert.equal(DOCUMENT_RECOVERY_MS, 15 * 60 * 1000)
})

test("a denied file's expiry never discards a different newly locked draft or extends the old lock", () => {
  const first = lockDocumentRecovery(new Map(), ["denied"], 0)
  const later = lockDocumentRecovery(first, ["denied", "healthy"], DOCUMENT_RECOVERY_MS - 1000)
  assert.equal(later.get("denied"), DOCUMENT_RECOVERY_MS)
  assert.equal(later.get("healthy"), 2 * DOCUMENT_RECOVERY_MS - 1000)
  assert.deepEqual(expiredDocumentRecovery(later, DOCUMENT_RECOVERY_MS), ["denied"])
  const repeated = lockDocumentRecovery(later, ["denied", "healthy"], 2 * DOCUMENT_RECOVERY_MS)
  assert.deepEqual([...repeated], [...later], "retrying a failed check cannot extend a locked file's recovery")
  assert.deepEqual(expiredDocumentRecovery(repeated, 2 * DOCUMENT_RECOVERY_MS), ["denied", "healthy"])
})
