import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono } from "hono"
import type { OpenRouterUnknownModelUsageReport } from "../src/webhooks.js"

process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_URL = "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890"
process.env.GATEWAY_WEBHOOK_SECRET = "local-dev-webhook-secret"

const { registerWebhookRoutes } = await import("../src/webhooks.js")

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function attribute(key: string, value: string | number | boolean) {
  if (typeof value === "string") return { key, value: { stringValue: value } }
  if (typeof value === "boolean") return { key, value: { boolValue: value } }
  if (Number.isInteger(value)) return { key, value: { intValue: value } }
  return { key, value: { doubleValue: value } }
}

function webhookRequest(body: unknown, headers: Record<string, string> = { authorization: "Bearer local-dev-webhook-secret" }) {
  return new Request("http://openwork.test/webhooks/openrouter", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

async function responseJson(response: Response) {
  const payload: unknown = await response.json()
  assert.ok(isRecord(payload))
  return payload
}

function createWebhookTestServer() {
  const app = new Hono()
  const organizationId = createDenTypeId("organization")
  const orgMembershipId = createDenTypeId("member")
  const inferenceKeyId = createDenTypeId("inferenceKey")
  const inferenceKey: {
    id: typeof inferenceKeyId
    status: string
    organization_id: typeof organizationId
    org_membership_id: typeof orgMembershipId
    revoked_at: Date | null
  } = {
    id: inferenceKeyId,
    status: "active",
    organization_id: organizationId,
    org_membership_id: orgMembershipId,
    revoked_at: null,
  }
  const chargedEntries = new Set<string>()
  const settlementTimes: Date[] = []
  const reports: OpenRouterUnknownModelUsageReport[] = []
  const insertedEntries: {
    openworkRequestId: string
    externalEventId: string | null
    costAmount: number | null
    modelId: string
    providerId: string
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
  }[] = []
  const bucketCharges: { amount: number }[] = []
  const calls = {
    settleUsage: 0,
    findInferenceKey: 0,
  }

  registerWebhookRoutes(app, {
    reporter: {
      unknownModel(report) {
        reports.push(report)
      },
    },
    async findInferenceKey(requestedKeyId) {
      calls.findInferenceKey += 1
      return requestedKeyId === inferenceKey.id ? inferenceKey : null
    },
    async settleUsage(input) {
      calls.settleUsage += 1
      settlementTimes.push(input.span.occurredAt)
      if (chargedEntries.has(input.span.openworkRequestId)) return "ingested"
      insertedEntries.push({
        openworkRequestId: input.span.openworkRequestId,
        externalEventId: input.span.externalEventId,
        costAmount: input.costAmount,
        modelId: input.span.reportedModel,
        providerId: "openrouter",
        inputTokens: input.span.usageMetadata.inputTokens,
        outputTokens: input.span.usageMetadata.outputTokens,
        totalTokens: input.span.usageMetadata.totalTokens,
      })
      if (input.costAmount === null) return "deferred"
      chargedEntries.add(input.span.openworkRequestId)
      bucketCharges.push({ amount: input.costAmount })
      return "ingested"
    },
  })

  function usagePayload(input: { requestId: string; eventId: string; generationId: string; requestModel: string; responseModel: string; includeSensitive?: boolean; inferenceKeyId?: string; orgMembershipId?: string; startedAt?: Date; occurredAt?: Date }) {
    const attributes = [
      ...(input.startedAt ? [attribute("trace.usage_started_at", input.startedAt.toISOString())] : []),
      attribute("trace.org_membership_id", input.orgMembershipId ?? orgMembershipId),
      attribute("trace.inference_key_id", input.inferenceKeyId ?? inferenceKeyId),
      attribute("trace.openwork_request_id", input.requestId),
      attribute("event_id", input.eventId),
      attribute("gen_ai.response.id", input.generationId),
      attribute("gen_ai.request.model", input.requestModel),
      attribute("gen_ai.response.model", input.responseModel),
      attribute("gen_ai.usage.input_cost", 0),
      attribute("gen_ai.usage.output_cost", 0),
      attribute("gen_ai.usage.input_tokens", 11),
      attribute("gen_ai.usage.output_tokens", 13),
      attribute("gen_ai.usage.total_tokens", 24),
      attribute("gen_ai.usage.currency", "USD"),
    ]
    if (input.includeSensitive) {
      attributes.push(
        attribute("authorization", "Bearer caller-secret"),
        attribute("gen_ai.prompt.0.content", "secret prompt content"),
        attribute("gen_ai.completion.0.content", "secret response content"),
      )
    }

    return {
      resourceSpans: [{
        resource: { attributes: [] },
        scopeSpans: [{
          scope: { attributes: [] },
          spans: [{
            traceId: "trace-123",
            spanId: "span-123",
            name: "OpenRouter usage",
            startTimeUnixNano: String(BigInt(input.startedAt?.getTime() ?? 1700000000000) * 1_000_000n),
            endTimeUnixNano: String(BigInt(input.occurredAt?.getTime() ?? 1700000001000) * 1_000_000n),
            attributes,
          }],
        }],
      }],
    }
  }

  return { app, reports, insertedEntries, bucketCharges, calls, organizationId, inferenceKey, settlementTimes, usagePayload }
}

test("retains unknown model usage without deduction and reports bounded provider facts", async () => {
  const { app, reports, insertedEntries, bucketCharges, calls, organizationId, usagePayload } = createWebhookTestServer()
  const response = await app.fetch(webhookRequest(usagePayload({
    requestId: "request-unknown",
    eventId: "event-unknown",
    generationId: "generation-unknown",
    requestModel: "z-ai/glm-5.2",
    responseModel: "vendor/new-model",
    includeSensitive: true,
  })))

  assert.equal(response.status, 200)
  const payload = await responseJson(response)
  assert.equal(payload.ingested, 0)
  assert.equal(payload.skipped, 0)
  assert.equal(payload.deferred, 1)
  assert.equal(calls.settleUsage, 1)
  assert.equal(insertedEntries.length, 1)
  assert.equal(insertedEntries[0]?.costAmount, null)
  assert.equal(bucketCharges.length, 0)
  assert.equal(reports.length, 1)

  const report = reports[0]
  assert.ok(report)
  assert.equal(report.reportedModel, "vendor/new-model")
  assert.equal(report.organizationId, organizationId)
  assert.equal(report.openworkRequestId, "request-unknown")
  assert.equal(report.externalEventId, "event-unknown")
  assert.equal(report.generationId, "generation-unknown")
  assert.equal(report.usage.requestModel, "z-ai/glm-5.2")
  assert.equal(report.usage.responseModel, "vendor/new-model")
  assert.equal(report.usage.inputTokens, 11)
  assert.equal(report.usage.outputTokens, 13)
  assert.equal(report.usage.totalTokens, 24)
  assert.equal(report.usage.currency, "USD")

  const diagnosticText = JSON.stringify(report)
  assert.ok(!diagnosticText.includes("caller-secret"))
  assert.ok(!diagnosticText.includes("secret prompt content"))
  assert.ok(!diagnosticText.includes("secret response content"))
})

test("deducts usage without Sentry diagnostics when OpenRouter usage reports a known model", async () => {
  const { app, reports, insertedEntries, bucketCharges, calls, usagePayload } = createWebhookTestServer()
  const response = await app.fetch(webhookRequest(usagePayload({
    requestId: "request-known",
    eventId: "event-known",
    generationId: "generation-known",
    requestModel: "z-ai/glm-5.2",
    responseModel: "z-ai/glm-5.2",
  })))

  assert.equal(response.status, 200)
  const payload = await responseJson(response)
  assert.equal(payload.ingested, 1)
  assert.equal(payload.skipped, 0)
  assert.equal(reports.length, 0)
  assert.equal(calls.settleUsage, 1)
  assert.deepEqual(insertedEntries, [{
    openworkRequestId: "request-known",
    externalEventId: "event-known",
    costAmount: 1,
    modelId: "z-ai/glm-5.2",
    providerId: "openrouter",
    inputTokens: 11,
    outputTokens: 13,
    totalTokens: 24,
  }])
  assert.deepEqual(bucketCharges, [{ amount: 1 }])
})

test("blank provider prices remain unpriced rather than fabricated zero charges", async () => {
  const { app, calls, insertedEntries, bucketCharges, usagePayload } = createWebhookTestServer()
  const payload = usagePayload({ requestId: "blank-price", eventId: "blank-price", generationId: "blank-price", requestModel: "z-ai/glm-5.2", responseModel: "z-ai/glm-5.2" })
  const span = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!
  span.attributes = span.attributes.map((attr) => attr.key === "gen_ai.usage.input_cost" || attr.key === "gen_ai.usage.output_cost" ? attribute(attr.key, " ") : attr)
  const response = await app.fetch(webhookRequest(payload))
  assert.equal(response.status, 200)
  assert.equal((await responseJson(response)).deferred, 1)
  assert.equal(calls.settleUsage, 1)
  assert.equal(insertedEntries[0]?.costAmount, null)
  assert.equal(bucketCharges.length, 0)
})

test("rejects malformed numeric usage consistently across resource, scope and span attributes", async () => {
  for (const [key, value] of [
    ["gen_ai.usage.input_cost", "-1"],
    ["gen_ai.usage.input_cost", "Infinity"],
    ["gen_ai.usage.input_tokens", "-1"],
    ["gen_ai.usage.output_tokens", "1.5"],
    ["gen_ai.usage.total_tokens", "2147483648"],
  ]) {
    for (const level of ["resource", "scope", "span"]) {
      const { app, calls, usagePayload } = createWebhookTestServer()
      const payload = usagePayload({ requestId: "invalid-numeric", eventId: "invalid-numeric", generationId: "invalid-numeric", requestModel: "z-ai/glm-5.2", responseModel: "z-ai/glm-5.2" })
      const attributes = payload.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes.filter((attr) => attr.key !== key)
      attributes.push(attribute(key!, value!))
      const response = await app.fetch(webhookRequest({ resourceSpans: [{
        resource: { attributes: level === "resource" ? attributes : [] },
        scopeSpans: [{ scope: { attributes: level === "scope" ? attributes : [] }, spans: [{ startTimeUnixNano: "1700000000000000000", attributes: level === "span" ? attributes : [] }] }],
      }] }))
      assert.equal(response.status, 400, `${level} ${key}=${value}`)
      assert.deepEqual(await responseJson(response), { ok: false, ingested: 0, skipped: 0, deferred: 0, invalid: 1, failed: 0 })
      assert.equal(calls.settleUsage, 0)
    }
  }
})

test("authenticated incurred usage settles after key revocation, including a later completion, without duplicate charges", async () => {
  const fixture = createWebhookTestServer()
  const startedAt = new Date("2026-09-08T12:00:00Z")
  const occurredAt = new Date("2026-09-08T12:02:00Z")
  assert.equal(fixture.inferenceKey.status, "active")
  const usage = {
    requestId: "request-accepted-before-revocation", eventId: "event-late", generationId: "generation-late",
    requestModel: "z-ai/glm-5.2", responseModel: "z-ai/glm-5.2", startedAt, occurredAt,
  }
  const payload = fixture.usagePayload(usage)
  fixture.inferenceKey.status = "revoked"
  fixture.inferenceKey.revoked_at = new Date("2026-09-08T12:01:00Z")
  assert.ok(startedAt < fixture.inferenceKey.revoked_at && occurredAt > fixture.inferenceKey.revoked_at)

  const first = await fixture.app.fetch(webhookRequest(payload, { "x-webhook-signature": "local-dev-webhook-secret" }))
  assert.equal(first.status, 200)
  assert.deepEqual(await responseJson(first), { ok: true, ingested: 1, skipped: 0, deferred: 0, invalid: 0, failed: 0 })
  assert.equal(fixture.settlementTimes[0]?.getTime(), startedAt.getTime())
  assert.equal(fixture.inferenceKey.status, "revoked")
  assert.equal(fixture.insertedEntries[0]?.openworkRequestId, usage.requestId)
  assert.equal(fixture.insertedEntries[0]?.costAmount, 1)

  const duplicate = await fixture.app.fetch(webhookRequest(payload))
  assert.equal(duplicate.status, 200)
  assert.deepEqual(await responseJson(duplicate), { ok: true, ingested: 1, skipped: 0, deferred: 0, invalid: 0, failed: 0 })
  assert.equal(fixture.calls.settleUsage, 2)
  assert.equal(fixture.insertedEntries.length, 1)
  assert.deepEqual(fixture.bucketCharges, [{ amount: 1 }])

  // A different event ID for the same request reuses the ledger entry and its
  // already-recorded bucket charge, rather than deducting incurred usage twice.
  const replay = await fixture.app.fetch(webhookRequest(fixture.usagePayload({ ...usage, eventId: "event-late-replay" })))
  assert.equal(replay.status, 200)
  assert.deepEqual(await responseJson(replay), { ok: true, ingested: 1, skipped: 0, deferred: 0, invalid: 0, failed: 0 })
  assert.equal(fixture.calls.settleUsage, 3)
  assert.equal(fixture.insertedEntries.length, 1)
  assert.deepEqual(fixture.bucketCharges, [{ amount: 1 }])
})

test("authenticated usage with an unknown inference key or Gateway key attribution is skipped without settlement", async () => {
  const fixture = createWebhookTestServer()
  for (const inferenceKeyId of [createDenTypeId("inferenceKey"), createDenTypeId("gatewayKey")]) {
    const response = await fixture.app.fetch(webhookRequest(fixture.usagePayload({
      requestId: "request-unknown-key", eventId: "event-unknown-key", generationId: "generation-unknown-key",
      requestModel: "z-ai/glm-5.2", responseModel: "z-ai/glm-5.2", inferenceKeyId,
    })))
    assert.equal(response.status, 200)
    assert.deepEqual(await responseJson(response), { ok: true, ingested: 0, skipped: 1, deferred: 0, invalid: 0, failed: 0 })
  }
  assert.equal(fixture.calls.settleUsage, 0)
  assert.equal(fixture.insertedEntries.length, 0)
  assert.equal(fixture.bucketCharges.length, 0)
})

test("revoked-key usage still requires webhook origin authentication before key lookup", async () => {
  const fixture = createWebhookTestServer()
  fixture.inferenceKey.status = "revoked"
  const payload = fixture.usagePayload({ requestId: "request-untrusted", eventId: "event-untrusted", generationId: "generation-untrusted",
    requestModel: "z-ai/glm-5.2", responseModel: "z-ai/glm-5.2" })
  const unauthorizedHeaders: Record<string, string>[] = [{}, { authorization: "Bearer wrong-secret" }, { "x-webhook-signature": "wrong-secret" },
    { authorization: "Bearer ow_inf_not-a-webhook-secret" }, { authorization: `Bearer ow_gw_${"A".repeat(43)}` }]
  for (const headers of unauthorizedHeaders) {
    const response = await fixture.app.fetch(webhookRequest(payload, headers))
    assert.equal(response.status, 401)
    assert.deepEqual(await responseJson(response), { error: "unauthorized" })
  }
  assert.equal(fixture.calls.findInferenceKey, 0)
  assert.equal(fixture.calls.settleUsage, 0)
  assert.equal(fixture.insertedEntries.length, 0)
  assert.equal(fixture.bucketCharges.length, 0)
})

test("known historical inference key cannot settle a different membership's usage", async () => {
  const fixture = createWebhookTestServer()
  fixture.inferenceKey.status = "revoked"
  const response = await fixture.app.fetch(webhookRequest(fixture.usagePayload({
    requestId: "request-wrong-member", eventId: "event-wrong-member", generationId: "generation-wrong-member",
    requestModel: "z-ai/glm-5.2", responseModel: "z-ai/glm-5.2", orgMembershipId: createDenTypeId("member"),
  })))
  assert.equal(response.status, 200)
  assert.deepEqual(await responseJson(response), { ok: true, ingested: 0, skipped: 1, deferred: 0, invalid: 0, failed: 0 })
  assert.equal(fixture.calls.settleUsage, 0)
  assert.equal(fixture.insertedEntries.length, 0)
  assert.equal(fixture.bucketCharges.length, 0)
})
