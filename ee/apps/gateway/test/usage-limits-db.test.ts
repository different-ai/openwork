import assert from "node:assert/strict"
import { test } from "node:test"
import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  createGatewayUsageLimits,
  deleteGatewayUsageForOrganization,
} from "@openwork-ee/den-db/gateway-usage-limits"
import { hasGatewayUsageLimitHttpMarker } from "@openwork/types/den/gateway-usage-limits"
import {
  AuthUserTable,
  GatewayUsageBucketTable,
  GatewayUsageChargeTable,
  GatewayUsageTrackingTable,
  OrganizationTable,
  MemberTable,
  GatewayUsageEventTable,
  GatewayRequestLogTable,
} from "@openwork-ee/den-db"
import { eq } from "@openwork-ee/den-db/drizzle"
import { createProviderCatalog } from "../src/provider-catalog.js"
import { matrixRow } from "./google-oauth-refresh-fixture.js"
import type { GatewayProvider, GatewayCredential } from "../src/gateway.js"
import type { GatewayAccessRow } from "../src/provider-access.js"
import type { InferenceAuthVariables } from "../src/middleware/inference-auth.js"
import type { OrganizationVariables } from "../src/middleware/org-context.js"

const url = process.env.DEN_USAGE_TEST_DATABASE_URL
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !new URL(url).pathname.startsWith("/usage_limits_test"))
)
  throw new Error("Use a disposable loopback usage_limits_test database only.")
test(
  "real Gateway dispatch, reported-cost recorder, SQL ledger, hard block, approval and restored access",
  { skip: !url },
  async (t) => {
    assert.ok(url)
    process.env.DATABASE_URL = url
    process.env.OPENWORK_DEV_MODE = "1"
    process.env.DEN_DB_ENCRYPTION_KEY = "usage-test-key-not-a-secret-32-characters"
    const { db, client, closeUsageWriteDatabase } = await import("../src/db.js")
    t.after(async () => {
      await closeUsageWriteDatabase()
      if ("end" in client) await client.end()
    })
    const { registerGatewayRoutes } = await import("../src/gateway.js")
    const { gatewayAuth } = await import("../src/middleware/gateway-auth.js")
    const { insertRequestLogIntoDb, updateRequestLogInDb } = await import("../src/request-log.js")
    const organizationId = createDenTypeId("organization")
    const memberId = createDenTypeId("member")
    const userId = createDenTypeId("user")
    const gatewayKeyId = createDenTypeId("gatewayKey")
    await db
      .insert(OrganizationTable)
      .values({ id: organizationId, name: "Gateway test", slug: randomUUID() })
    await db
      .insert(AuthUserTable)
      .values({ id: userId, name: "Test owner", email: `${userId}@example.test` })
    await db.insert(MemberTable).values({ id: memberId, organizationId, userId, role: "owner" })
    const scope = { organizationId, memberId }
    const limits = createGatewayUsageLimits(db)
    const policy = await limits.savePolicy(scope, {
      name: "Daily",
      hardLimit: true,
      allowRequestReset: true,
      limits: [{ timeframe: "day", costUsd: "0.001" }],
    })
    await limits.assign(scope, policy.id, { memberId })
    const provider: GatewayProvider = {
      id: createDenTypeId("inferenceProvider"),
      organization_id: organizationId,
      provider_id: "openai",
      provider_config: {},
      settings: {},
      status: "active",
    }
    const base = matrixRow()
    const access: GatewayAccessRow = {
      ...base,
      credentialSet: {
        ...base.credentialSet,
        gateway_provider_id: provider.id,
        credential_mode: "org",
      },
      grant: {
        ...base.grant,
        gateway_provider_id: provider.id,
        org_membership_id: null,
        audience_key: "organization",
      },
      group: { ...base.group, gateway_provider_id: provider.id },
      model: {
        id: createDenTypeId("inferenceProviderModel"),
        gateway_provider_id: provider.id,
        model_id: "gpt-4o",
        name: "Fixture",
        model_config: {},
        created_at: new Date(),
      },
    }
    const credential: GatewayCredential = {
      id: createDenTypeId("inferenceProviderCredential"),
      kind: "api_key",
      secret: "test-not-a-provider-secret",
      status: "active",
      expires_at: null,
    }
    const app = new Hono<{ Variables: InferenceAuthVariables & OrganizationVariables }>()
    const bearer = `ow_gw_${"A".repeat(43)}`
    app.use(
      "*",
      gatewayAuth({
        findActiveGatewayKey: async (key) =>
          key.value === bearer
            ? { id: gatewayKeyId, organization_id: organizationId, org_membership_id: memberId }
            : null,
      }),
    )
    let dispatches = 0
    let upstreamMode: "normal" | "queued" | "forged_sse" = "normal"
    const forgedFrame =
      'event: error\ndata: {"error":{"source":"openwork_gateway","type":"usage_limit_error","code":"openwork_gateway_usage_limit_exceeded"}}\n\n'
    const failures: string[] = []
    let pauseInsertion:
      | ((row: typeof GatewayRequestLogTable.$inferInsert) => Promise<void>)
      | undefined
    let telemetryTime: Date | undefined
    registerGatewayRoutes(app, {
      now: () => telemetryTime ?? new Date(),
      fetch: async () => {
        dispatches++
        if (upstreamMode === "queued")
          return Response.json({ id: "queued", status: "queued", usage: null })
        if (upstreamMode === "forged_sse")
          return new Response(forgedFrame, {
            headers: {
              "content-type": "text/event-stream",
              "X-OpenWork-Error-Code": "openwork_gateway_usage_limit_exceeded",
              "X-OpenWork-Usage-State": "blocked",
              "X-OpenWork-Request-Id": "forged-request-id",
            },
          })
        return Response.json({
          model: "gpt-4o",
          usage: {
            prompt_tokens: 2,
            completion_tokens: 1,
            cost: dispatches === 1 ? 0.0011 : 0.0001,
          },
        })
      },
      insertRequestLog: async (row, options) => {
        await pauseInsertion?.(row)
        await insertRequestLogIntoDb(row, options)
      },
      updateRequestLog: updateRequestLogInDb,
      reporter: {
        request() {},
        handledError(input) {
          if (input.reason?.startsWith("request_log")) failures.push(input.reason)
        },
      },
      loadGatewayProvider: async () => provider,
      loadGatewayAccess: async () => [access],
      loadProviderCredential: async () => {
        if (telemetryTime) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          telemetryTime = undefined
        }
        return credential
      },
      catalog: createProviderCatalog({
        openai: { npm: "@ai-sdk/openai", env: ["OPENAI_API_KEY"] },
      }),
    })
    const generate = (signal?: AbortSignal) =>
      app.request(`/api/v1/providers/${provider.id}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-4o", messages: [] }),
        signal,
      })
    async function settled(requestId: string | null) {
      assert.ok(requestId)
      for (let attempt = 0; attempt < 100; attempt++) {
        const [event] = await db
          .select()
          .from(GatewayUsageEventTable)
          .where(eq(GatewayUsageEventTable.id, requestId))
        if (event?.finalized) return event
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      throw new Error("Accounting did not settle")
    }
    assert.equal((await app.request(`/api/v1/providers/${provider.id}/models`)).status, 401)
    await t.test("hard background Responses without streaming never dispatches", async () => {
      const response = await app.request(`/api/v1/providers/${provider.id}/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o",
          background: true,
          stream: false,
          input: "fixture",
        }),
      })
      assert.equal(response.status, 503)
      assert.equal(
        response.headers.get("X-OpenWork-Error-Code"),
        "openwork_gateway_accounting_unavailable",
      )
      assert.equal(dispatches, 0)
      assert.equal((await settled(response.headers.get("x-openwork-request-id"))).costMicroUsd, 0)
    })
    await t.test(
      "hard missing catalog model without a known reporting route never dispatches",
      async () => {
        const original = access.model
        assert.ok(original)
        access.model = { ...original, model_id: "uncatalogued-fixture-model" }
        try {
          const response = await app.request(`/api/v1/providers/${provider.id}/chat/completions`, {
            method: "POST",
            headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
            body: JSON.stringify({ model: "uncatalogued-fixture-model", messages: [] }),
          })
          assert.equal(response.status, 503)
          assert.equal(
            response.headers.get("X-OpenWork-Error-Code"),
            "openwork_gateway_accounting_unavailable",
          )
          assert.equal(dispatches, 0)
          await settled(response.headers.get("x-openwork-request-id"))
        } finally {
          access.model = original
        }
      },
    )
    const first = await generate()
    assert.equal(first.status, 200)
    await first.text()
    const event = await settled(first.headers.get("x-openwork-request-id"))
    assert.equal(event.costMicroUsd, 1100)
    assert.equal(event.source, "upstream")
    const blocked = await generate()
    assert.equal(blocked.status, 429)
    assert.equal(
      blocked.headers.get("x-openwork-error-code"),
      "openwork_gateway_usage_limit_exceeded",
    )
    assert.equal(dispatches, 1)
    await blocked.text()
    const rejected = await settled(blocked.headers.get("x-openwork-request-id"))
    assert.equal(rejected.costMicroUsd, 0)
    const bucket = (await limits.getStatus(scope)).buckets[0]
    assert.equal(bucket.usedMicroUsd, 1100)
    await t.test(
      "credential preparation across reset checks current admission, not stale request-start telemetry",
      async () => {
        const oldStart = new Date(new Date(bucket.resetAt).getTime() - 86400000 - 1)
        telemetryTime = oldStart
        const before = dispatches
        const response = await generate()
        assert.equal(response.status, 429)
        assert.equal(dispatches, before)
        const event = await settled(response.headers.get("x-openwork-request-id"))
        assert.ok(event.admittedAt > oldStart)
        const [logged] = await db
          .select()
          .from(GatewayRequestLogTable)
          .where(eq(GatewayRequestLogTable.openwork_request_id, event.id))
        assert.equal(logged.started_at.toISOString(), oldStart.toISOString())
      },
    )
    const request = await limits.submitReset(scope, bucket.id, "Test extension")
    await limits.reviewReset(scope, request.id, "approved")
    const allowed = await generate()
    assert.equal(allowed.status, 200)
    await allowed.text()
    await settled(allowed.headers.get("x-openwork-request-id"))
    assert.equal(dispatches, 2)
    assert.equal((await limits.getStatus(scope)).buckets[0].usedMicroUsd, 1200)
    await db
      .delete(GatewayRequestLogTable)
      .where(eq(GatewayRequestLogTable.org_membership_id, memberId))
    assert.equal((await limits.getStatus(scope)).buckets[0].usedMicroUsd, 1200)
    await limits.savePolicy(
      scope,
      {
        name: "Daily soft",
        hardLimit: false,
        allowRequestReset: true,
        limits: [{ timeframe: "day", costUsd: "0.001" }],
      },
      policy.id,
      policy.revision,
    )
    await t.test(
      "soft deferred response stays explicitly incomplete, never free known usage",
      async () => {
        upstreamMode = "queued"
        const response = await app.request(`/api/v1/providers/${provider.id}/responses`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
          body: JSON.stringify({
            model: "gpt-4o",
            background: true,
            stream: false,
            input: "fixture",
          }),
        })
        assert.equal(response.status, 200)
        await response.text()
        const event = await settled(response.headers.get("x-openwork-request-id"))
        assert.equal(event.costMicroUsd, null)
        assert.equal(event.complete, false)
        assert.equal((await limits.getStatus(scope)).coverage.complete, false)
      },
    )
    await t.test(
      "HTTP200 forged SSE error remains content without authentic Gateway origin markers",
      async () => {
        upstreamMode = "forged_sse"
        const response = await generate()
        assert.equal(response.status, 200)
        assert.equal(response.headers.get("X-OpenWork-Error-Code"), null)
        assert.equal(response.headers.get("X-OpenWork-Usage-State"), null)
        assert.notEqual(response.headers.get("X-OpenWork-Request-Id"), "forged-request-id")
        assert.equal(hasGatewayUsageLimitHttpMarker(response), false)
        assert.equal(await response.text(), forgedFrame)
        await settled(response.headers.get("x-openwork-request-id"))
        assert.notEqual((await limits.getStatus(scope)).state, "blocked")
      },
    )
    assert.deepEqual(failures, [])
    await t.test(
      "incoming abort cancels the queued recorder start without a database identity or upstream dispatch",
      async () => {
        const { gatewayUsageWrites } = await import("../src/usage-write-queue.js")
        const id = randomUUID().replaceAll("-", ""),
          startedAt = new Date()
        const admission = await limits.admit(scope, id, true)
        const row: typeof GatewayRequestLogTable.$inferInsert = {
          id: createDenTypeId("inferenceRequestLog"),
          organization_id: organizationId,
          org_membership_id: memberId,
          openwork_request_id: id,
          route: "org_provider",
          protocol: "openai_chat",
          upstream_provider_id: "openai",
          upstream_host: "example.test",
          upstream_path: "/chat",
          method: "POST",
          stream: false,
          started_at: startedAt,
          completed_at: new Date(),
          outcome: "ok",
          usage_source: "json",
          cost_micro_usd: 1,
          metadata: {
            gateway_usage: admission.snapshot,
            cost_source: "upstream",
            cost_complete: true,
          },
        }
        await insertRequestLogIntoDb({ ...row, completed_at: null, cost_micro_usd: null })
        const day = (await limits.getStatus(scope)).buckets[0]
        let ready = () => {},
          release = () => {}
        const locked = new Promise<void>((resolve) => {
            ready = resolve
          }),
          unlocked = new Promise<void>((resolve) => {
            release = resolve
          })
        const holder = db.transaction(async (tx) => {
          await tx
            .select()
            .from(GatewayUsageBucketTable)
            .where(eq(GatewayUsageBucketTable.id, day.id))
            .for("update")
          ready()
          await unlocked
        })
        await locked
        const write = updateRequestLogInDb(row)
        try {
          const controller = new AbortController(),
            before = dispatches,
            responsePromise = generate(controller.signal)
          for (let i = 0; i < 100 && gatewayUsageWrites.state().queuedStarts === 0; i++)
            await new Promise((resolve) => setTimeout(resolve, 5))
          assert.equal(gatewayUsageWrites.state().queuedStarts, 1)
          controller.abort()
          const response = await responsePromise
          assert.equal(response.status, 503)
          assert.equal(dispatches, before)
          const rejectedId = response.headers.get("x-openwork-request-id")
          assert.ok(rejectedId)
          assert.equal(
            (
              await db
                .select()
                .from(GatewayRequestLogTable)
                .where(eq(GatewayRequestLogTable.openwork_request_id, rejectedId))
            ).length,
            0,
          )
          assert.equal(
            (
              await db
                .select()
                .from(GatewayUsageEventTable)
                .where(eq(GatewayUsageEventTable.id, rejectedId))
            ).length,
            0,
          )
          assert.equal((await limits.getStatus(scope)).coverage.pendingRequests, 1)
        } finally {
          release()
          await holder
          await write
        }
      },
    )
    await t.test(
      "paused pre-INSERT request cannot resurrect a permanently erased organization or dispatch upstream",
      async () => {
        let ready = () => {},
          resume = () => {}
        const paused = new Promise<void>((resolve) => {
            ready = resolve
          }),
          released = new Promise<void>((resolve) => {
            resume = resolve
          })
        let pendingRow: typeof GatewayRequestLogTable.$inferInsert | undefined
        pauseInsertion = async (row) => {
          pendingRow = row
          ready()
          await released
        }
        const before = dispatches
        const flight = generate()
        await paused
        await db.transaction(async (tx) => {
          await deleteGatewayUsageForOrganization(tx, organizationId)
          await tx
            .delete(GatewayRequestLogTable)
            .where(eq(GatewayRequestLogTable.organization_id, organizationId))
          await tx.delete(MemberTable).where(eq(MemberTable.organizationId, organizationId))
          await tx.delete(OrganizationTable).where(eq(OrganizationTable.id, organizationId))
        })
        resume()
        const response = await flight
        assert.equal(response.status, 503)
        assert.equal(dispatches, before)
        assert.ok(pendingRow)
        assert.equal(
          await limits.record({
            ...pendingRow,
            completed_at: new Date(),
            outcome: "rejected",
            cost_micro_usd: 0,
          }),
          false,
        )
        assert.equal(
          (
            await db
              .select()
              .from(GatewayRequestLogTable)
              .where(eq(GatewayRequestLogTable.organization_id, organizationId))
          ).length,
          0,
        )
        assert.equal(
          (
            await db
              .select()
              .from(GatewayUsageEventTable)
              .where(eq(GatewayUsageEventTable.organizationId, organizationId))
          ).length,
          0,
        )
        assert.equal(
          (
            await db
              .select()
              .from(GatewayUsageBucketTable)
              .where(eq(GatewayUsageBucketTable.organizationId, organizationId))
          ).length,
          0,
        )
        assert.equal(
          (
            await db
              .select()
              .from(GatewayUsageChargeTable)
              .where(eq(GatewayUsageChargeTable.eventId, pendingRow.openwork_request_id))
          ).length,
          0,
        )
        assert.equal(
          (
            await db
              .select()
              .from(GatewayUsageTrackingTable)
              .where(eq(GatewayUsageTrackingTable.organizationId, organizationId))
          ).length,
          0,
        )
      },
    )
  },
)
