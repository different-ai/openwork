import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { createRequestLogRecorder, type GatewayRequestLogRow } from "./request-log.js"

function hasUsageSnapshot(row: GatewayRequestLogRow | undefined) {
  const metadata = row?.metadata
  return typeof metadata === "object" && metadata !== null && "gateway_usage" in metadata
}

// Admission skipped ("usage limits off") means the recorder never receives a
// usage snapshot. Accounting must still write the log row and settle its cost.
test("a request without an admission snapshot is still logged and settled with cost", async () => {
  const inserted: GatewayRequestLogRow[] = []
  const updated: GatewayRequestLogRow[] = []
  const recorder = createRequestLogRecorder({
    insertRequestLog: async (row) => { inserted.push(row) },
    updateRequestLog: async (row) => { updated.push(row); return true },
    reporter: { request: () => {}, handledError: () => {} },
    pricing: { getModelPrice: () => null },
  })

  recorder.start({
    identity: {
      kind: "gateway",
      organizationId: createDenTypeId("organization"),
      orgMembershipId: createDenTypeId("member"),
      gatewayKeyId: createDenTypeId("gatewayKey"),
    },
    openworkRequestId: "request_without_admission",
    route: "org_provider",
    protocol: "openai_chat",
    upstreamProviderId: "openai",
    upstreamHost: "api.openai.com",
    upstreamPath: "/v1/chat/completions",
    method: "POST",
    requestedModel: "gpt-4o-mini",
    upstreamModel: "gpt-4o-mini",
    stream: false,
  })
  assert.equal(await recorder.whenStarted?.(), true)
  recorder.setUsage({ usageSource: "json", inputTokens: 10, outputTokens: 5, costUsd: 0.0012 })
  await recorder.finish({ status: 200, outcome: "ok" })

  assert.equal(inserted.length, 1)
  assert.equal(inserted[0]?.route, "org_provider")
  assert.equal(hasUsageSnapshot(inserted[0]), false)
  assert.equal(updated.length, 1)
  assert.equal(updated[0]?.cost_micro_usd, 1200)
  assert.equal(hasUsageSnapshot(updated[0]), false)
})
