import assert from "node:assert/strict"
import { test } from "node:test"
import { sanitizeFields, sanitizeText } from "../src/observability/safe-fields.js"

const session = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=fixture-upload-secret"

test("Google upload URLs are bearer credentials and never appear in telemetry fields", () => {
  const fields = sanitizeFields({ uploadUrl: session, nested: { upload_url: session }, message: `Upload failed at ${session}` })
  assert.equal(fields?.uploadUrl, "[redacted]")
  assert.deepEqual(fields?.nested, { upload_url: "[redacted]" })
  assert.equal(JSON.stringify(fields).includes("fixture-upload-secret"), false)
  assert.equal(sanitizeText(`provider error: ${session}`).includes("fixture-upload-secret"), false)
})
