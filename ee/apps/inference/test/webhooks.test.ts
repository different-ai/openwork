import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { Hono } from "hono"
import type { OpenRouterUnknownModelUsageReport } from "../src/webhooks.js"

process.env.OPENWORK_DEV_MODE = "1"
process.env.DATABASE_URL = "mysql://root:password@127.0.0.1:3306/openwork_den"
process.env.DEN_DB_ENCRYPTION_KEY = "local-dev-db-encryption-key-please-change-1234567890"
process.env.INFERENCE_WEBHOOK_SECRET = "local-dev-webhook-secret"

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

function webhookRequest(body: unknown) {
  return new Request("http://openwork.test/webhooks/openrouter", {
    method: "POST",
    headers: {
      authorization: "Bearer local-dev-webhook-secret",
      "content-type": "application/json",
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
  const ledgerEntryId = createDenTypeId("inferenceUsageLedgerEntry")
  const bucketId = createDenTypeId("inferenceOrgUsageBucket")
  const reports: OpenRouterUnknownModelUsageReport[] = []
  const insertedEntries: { openworkRequestId: string; externalEventId: string | null; costAmount: number }[] = []
  const bucketCharges: { amount: number }[] = []
  const calls = {
    ensureUsableBuckets: 0,
    findLedgerEntryByExternalEventId: 0,
    findOpenRouterUsageLedgerEntry: 0,
    insertOpenRouterUsageLedgerEntry: 0,
    chargeBuckets: 0,
  }

  registerWebhookRoutes(app, {
    reporter: {
      unknownModel(report) {
        reports.push(report)
      },
    },
    async findInferenceKey(_inferenceKeyId) {
      return {
        id: inferenceKeyId,
        status: "active",
        organization_id: organizationId,
        org_membership_id: orgMembershipId,
      }
    },
    async ensureUsableBuckets(_organizationId, _occurredAt) {
      calls.ensureUsableBuckets += 1
      return {
        ok: true,
        bucketIds: { monthly: bucketId },
        bucketLimits: { monthly: 1_000_000 },
      }
    },
    async findLedgerEntryByExternalEventId(_externalEventId) {
      calls.findLedgerEntryByExternalEventId += 1
      return null
    },
    async findOpenRouterUsageLedgerEntry(_openworkRequestId) {
      calls.findOpenRouterUsageLedgerEntry += 1
      return null
    },
    async insertOpenRouterUsageLedgerEntry(input) {
      calls.insertOpenRouterUsageLedgerEntry += 1
      insertedEntries.push({
        openworkRequestId: input.span.openworkRequestId,
        externalEventId: input.span.externalEventId,
        costAmount: input.costAmount,
      })
      return { id: ledgerEntryId }
    },
    async chargeBuckets(input) {
      calls.chargeBuckets += 1
      bucketCharges.push({ amount: input.costAmount })
    },
  })

  function usagePayload(input: { requestId: string; eventId: string; generationId: string; requestModel: string; responseModel: string; includeSensitive?: boolean }) {
    const attributes = [
      attribute("trace.org_membership_id", orgMembershipId),
      attribute("trace.inference_key_id", inferenceKeyId),
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
            startTimeUnixNano: "1700000000000000000",
            endTimeUnixNano: "1700000001000000000",
            attributes,
          }],
        }],
      }],
    }
  }

  return { app, reports, insertedEntries, bucketCharges, calls, organizationId, usagePayload }
}

test("reports fatal Sentry diagnostics and skips deduction when OpenRouter usage reports an unknown model", async () => {
  const { app, reports, insertedEntries, bucketCharges, calls, organizationId, usagePayload } = createWebhookTestServer()
  const response = await app.fetch(webhookRequest(usagePayload({
    requestId: "request-unknown",
    eventId: "event-unknown",
    generationId: "generation-unknown",
    requestModel: "openrouter/fusion",
    responseModel: "vendor/new-model",
    includeSensitive: true,
  })))

  assert.equal(response.status, 200)
  const payload = await responseJson(response)
  assert.equal(payload.ingested, 0)
  assert.equal(payload.skipped, 1)
  assert.equal(calls.ensureUsableBuckets, 0)
  assert.equal(calls.findLedgerEntryByExternalEventId, 0)
  assert.equal(calls.findOpenRouterUsageLedgerEntry, 0)
  assert.equal(calls.insertOpenRouterUsageLedgerEntry, 0)
  assert.equal(calls.chargeBuckets, 0)
  assert.equal(insertedEntries.length, 0)
  assert.equal(bucketCharges.length, 0)
  assert.equal(reports.length, 1)

  const report = reports[0]
  assert.ok(report)
  assert.equal(report.reportedModel, "vendor/new-model")
  assert.equal(report.organizationId, organizationId)
  assert.equal(report.openworkRequestId, "request-unknown")
  assert.equal(report.externalEventId, "event-unknown")
  assert.equal(report.generationId, "generation-unknown")
  assert.equal(report.usage.requestModel, "openrouter/fusion")
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
    requestModel: "openrouter/fusion",
    responseModel: "openrouter/fusion",
  })))

  assert.equal(response.status, 200)
  const payload = await responseJson(response)
  assert.equal(payload.ingested, 1)
  assert.equal(payload.skipped, 0)
  assert.equal(reports.length, 0)
  assert.equal(calls.ensureUsableBuckets, 1)
  assert.equal(calls.findLedgerEntryByExternalEventId, 1)
  assert.equal(calls.findOpenRouterUsageLedgerEntry, 1)
  assert.equal(calls.insertOpenRouterUsageLedgerEntry, 1)
  assert.equal(calls.chargeBuckets, 1)
  assert.deepEqual(insertedEntries, [{ openworkRequestId: "request-known", externalEventId: "event-known", costAmount: 1 }])
  assert.deepEqual(bucketCharges, [{ amount: 1 }])
})
