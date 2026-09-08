/** Deterministic OpenRouter witness and disposable-DB arrangement for the anonymous inference journey. */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

const anonymousUpstreamKey = "anonymous-inference-fixture-upstream";
const paidUpstreamKey = "anonymous-inference-fixture-paid-upstream";
export function paidFixtureKey(memberId) { return `ow_inf_anonymous-fixture-${memberId}`; }

async function database() {
  const { createDenDb } = await import("../../../../ee/packages/den-db/src/client.ts");
  const { db } = createDenDb({ databaseUrl: process.env.DATABASE_URL, mode: "mysql" });
  return db;
}

async function arrange(command, orgId, memberId) {
  if (command === "migrate-anonymous") {
    const { createConnection } = await import("../../../../ee/packages/den-db/node_modules/mysql2/promise.js");
    const connection = await createConnection(process.env.DATABASE_URL);
    try {
      const [tables] = await connection.query("SHOW TABLES LIKE 'anonymous_inference_control'");
      if (Array.isArray(tables) && tables.length === 0) {
        const migration = await readFile(new URL("../../../../ee/packages/den-db/drizzle/0094_anonymous_inference.sql", import.meta.url), "utf8");
        for (const statement of migration.split("--> statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
          await connection.query(statement);
        }
      }
    } finally {
      await connection.end();
    }
    console.log("Anonymous inference schema ready");
    return;
  }
  const db = await database();
  const schema = await import("../../../../ee/packages/den-db/src/schema.ts");
  const { and, eq, sql } = await import("../../../../ee/packages/den-db/src/drizzle.ts");
  const { createDenTypeId, normalizeDenTypeId } = await import("../../../../ee/packages/utils/src/typeid.ts");
  if (command === "subscription") {
    const id = normalizeDenTypeId("organization", orgId);
    await db.insert(schema.OrgSubscriptionTable).values({
      id: createDenTypeId("orgSubscription"), organization_id: id, type: "inference", status: "active",
      stripe_customer_id: `cus_anonymous_fixture_${orgId}`, stripe_subscription_id: `sub_anonymous_fixture_${orgId}`, quantity: 1,
    });
    await db.insert(schema.InferenceOrgUpstreamProviderKeyTable).values({
      id: createDenTypeId("inferenceOrgProviderKey"), organization_id: id, provider: "openrouter",
      encrypted_api_key: paidUpstreamKey, status: "active",
    });
  } else if (command === "ensure-control") {
    await db.insert(schema.AnonymousInferenceControlTable).values({ id: "anonymous-inference-global" })
      .onDuplicateKeyUpdate({ set: { id: "anonymous-inference-global" } });
  } else if (command === "configure-paid") {
    const key = paidFixtureKey(memberId);
    await db.update(schema.InferenceKeyTable).set({ key_hash: createHash("sha256").update(key).digest("hex") }).where(and(
      eq(schema.InferenceKeyTable.organization_id, normalizeDenTypeId("organization", orgId)),
      eq(schema.InferenceKeyTable.org_membership_id, normalizeDenTypeId("member", memberId)),
      eq(schema.InferenceKeyTable.status, "active"),
    ));
  } else if (command === "reset-anonymous") {
    await db.delete(schema.AnonymousInferenceReservationChargeTable);
    await db.delete(schema.AnonymousInferenceReservationTable);
    await db.delete(schema.AnonymousInferenceUsageBucketTable);
    await db.delete(schema.AnonymousInferenceRateBucketTable);
    await db.update(schema.AnonymousInferenceControlTable).set({ blocked: false, blocked_at: null, block_reason: null });
  } else if (command === "pause-anonymous") {
    await db.execute(sql.raw("RENAME TABLE anonymous_inference_usage_buckets TO anonymous_inference_usage_buckets_unavailable"));
  } else if (command === "resume-anonymous") {
    await db.execute(sql.raw("RENAME TABLE anonymous_inference_usage_buckets_unavailable TO anonymous_inference_usage_buckets"));
  } else if (command === "accounting") {
    const reservations = await db.select({
      status: schema.AnonymousInferenceReservationTable.status,
      reservedMicroUsd: schema.AnonymousInferenceReservationTable.reserved_micro_usd,
      settledMicroUsd: schema.AnonymousInferenceReservationTable.settled_micro_usd,
    }).from(schema.AnonymousInferenceReservationTable);
    const buckets = await db.select({
      scope: schema.AnonymousInferenceUsageBucketTable.scope,
      windowType: schema.AnonymousInferenceUsageBucketTable.window_type,
      usedMicroUsd: schema.AnonymousInferenceUsageBucketTable.used_micro_usd,
    }).from(schema.AnonymousInferenceUsageBucketTable);
    const rateBuckets = await db.select({
      kind: schema.AnonymousInferenceRateBucketTable.kind,
      scope: schema.AnonymousInferenceRateBucketTable.scope,
      usedAmount: schema.AnonymousInferenceRateBucketTable.used_amount,
    }).from(schema.AnonymousInferenceRateBucketTable);
    const [control] = await db.select({ blocked: schema.AnonymousInferenceControlTable.blocked }).from(schema.AnonymousInferenceControlTable).limit(1);
    console.log(JSON.stringify({ reservations, buckets, rateBuckets, blocked: control?.blocked ?? null }));
    return;
  } else {
    throw new Error(`Unknown anonymous inference fixture command: ${command}`);
  }
  console.log("Anonymous inference fixture ready");
}

async function serveWitness() {
  const calls = [];
  const waiting = new Set();
  let errorBodiesClosed = 0;
  const server = createServer(async (request, response) => {
    if (request.url === "/health") { response.end("ok"); return; }
    if (request.url === "/fixture/requests") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ calls, waiting: waiting.size, errorBodiesClosed }));
      return;
    }
    if (request.url === "/fixture/release") {
      for (const release of waiting) release();
      response.end("{}");
      return;
    }
    if (request.url?.startsWith("/fixture/control-lock")) {
      const delayMs = Math.min(5_000, Math.max(1, Number(new URL(request.url, "http://fixture").searchParams.get("ms") ?? "1000")));
      const db = await database();
      const schema = await import("../../../../ee/packages/den-db/src/schema.ts");
      const { eq } = await import("../../../../ee/packages/den-db/src/drizzle.ts");
      await db.transaction(async (tx) => {
        await tx.select().from(schema.AnonymousInferenceControlTable)
          .where(eq(schema.AnonymousInferenceControlTable.id, "anonymous-inference-global")).limit(1).for("update");
        response.writeHead(200, { "content-type": "text/plain" });
        response.write("locked");
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      });
      response.end(" released");
      return;
    }
    let text = "";
    for await (const chunk of request) {
      text += chunk.toString();
      if (text.length > 1_048_576) { response.writeHead(413).end(); return; }
    }
    let payload;
    try { payload = JSON.parse(text); }
    catch { response.writeHead(400).end(); return; }
    const prompt = JSON.stringify(payload.messages ?? []);
    const marker = prompt.includes("fixture:cancellation")
      ? "cancellation"
      : prompt.includes("fixture:provisioning")
        ? "provisioning"
        : null;
    const missingUsage = prompt.includes("fixture:missing-usage");
    const hold = prompt.includes("fixture:hold");
    const outage = prompt.includes("fixture:outage");
    const authorization = request.headers.authorization;
    const availableTools = Array.isArray(payload.tools) ? payload.tools.map((tool) => tool?.function?.name).filter((name) => typeof name === "string") : [];
    const hasAssistantMessage = Array.isArray(payload.messages) && payload.messages.some((message) => message?.role === "assistant");
    const useFixtureTool = !hasAssistantMessage && availableTools.includes("glob");
    calls.push({
      authenticated: authorization === `Bearer ${anonymousUpstreamKey}` ? "anonymous" : authorization === `Bearer ${paidUpstreamKey}` ? "paid" : "unknown",
      model: payload.model,
      provider: payload.provider,
      maxTokens: payload.max_tokens,
      n: payload.n,
      reasoning: payload.reasoning,
      reasoningEffort: payload.reasoningEffort,
      textVerbosity: payload.textVerbosity,
      verbosity: payload.verbosity,
      stream: payload.stream === true,
      streamOptions: payload.stream_options,
      usage: payload.usage,
      toolChoice: payload.tool_choice,
      toolCount: Array.isArray(payload.tools) ? payload.tools.length : 0,
      tools: payload.tools,
      toolNames: Array.isArray(payload.tools) ? payload.tools.map((tool) => tool?.function?.name).filter((name) => typeof name === "string") : [],
      messageRoles: Array.isArray(payload.messages) ? payload.messages.map((message) => message?.role) : [],
      canonicalBytes: Buffer.byteLength(text, "utf8"),
      hasPlugins: Object.prototype.hasOwnProperty.call(payload, "plugins"),
      marker,
    });
    if (outage) {
      response.writeHead(503, { "content-type": "application/json" });
      response.write(JSON.stringify({ error: { message: "private fixture outage detail" } }));
      const timer = setTimeout(() => response.end(), 5_000);
      response.once("close", () => { clearTimeout(timer); errorBodiesClosed += 1; });
      return;
    }
    const id = `chatcmpl-${randomUUID()}`;
    const byokMissingPrincipal = prompt.includes("fixture:byok-missing-principal");
    const byokZeroFee = prompt.includes("fixture:byok-zero-fee");
    const byokFlagMismatch = prompt.includes("fixture:byok-flag-mismatch");
    const inclusiveReasoning = prompt.includes("fixture:reasoning-inclusive");
    const reasoningOverTotal = prompt.includes("fixture:reasoning-over-total");
    const completionTokens = inclusiveReasoning ? 4_096 : 20;
    const usage = {
      prompt_tokens: 100, completion_tokens: completionTokens, total_tokens: 100 + completionTokens,
      completion_tokens_details: { reasoning_tokens: inclusiveReasoning ? 2_048 : reasoningOverTotal ? 21 : 0 },
      is_byok: !byokFlagMismatch,
      cost: prompt.includes("fixture:over-cost") ? 0.05 : byokZeroFee ? 0 : byokFlagMismatch ? 0.0001 : 0.000005,
      ...(byokFlagMismatch ? { cost_details: { upstream_inference_cost: 0.0001 } }
        : byokMissingPrincipal ? {}
          : { cost_details: { upstream_inference_cost: prompt.includes("fixture:over-cost") || prompt.includes("fixture:late-over-cost") ? 1 : 0.0001 } }),
    };
    if (prompt.includes("fixture:late-over-cost")) {
      const db = await database();
      const schema = await import("../../../../ee/packages/den-db/src/schema.ts");
      const { eq } = await import("../../../../ee/packages/den-db/src/drizzle.ts");
      await db.transaction(async (tx) => {
        await tx.select().from(schema.AnonymousInferenceControlTable)
          .where(eq(schema.AnonymousInferenceControlTable.id, "anonymous-inference-global")).limit(1).for("update");
        await tx.update(schema.AnonymousInferenceReservationTable).set({ status: "retained", released_at: new Date() })
          .where(eq(schema.AnonymousInferenceReservationTable.status, "active"));
      });
    }
    if (!payload.stream) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id, model: payload.model, provider: "fixture-provider", choices: [{
          index: 0,
          message: useFixtureTool
            ? { role: "assistant", content: null, tool_calls: [{ id: "anonymous-fixture-glob", type: "function", function: { name: "glob", arguments: JSON.stringify({ pattern: "*", path: "." }) } }] }
            : { role: "assistant", content: "Anonymous Models are working." },
          finish_reason: useFixtureTool ? "tool_calls" : "stop",
        }],
        ...(missingUsage ? {} : { usage }),
      }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (useFixtureTool) {
      response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: payload.model, provider: "fixture-provider", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "anonymous-fixture-glob", type: "function", function: { name: "glob", arguments: JSON.stringify({ pattern: "*", path: "." }) } }] }, finish_reason: "tool_calls" }] })}\n\n`);
      if (!missingUsage) response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: payload.model, provider: "fixture-provider", choices: [], usage })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: payload.model, provider: "fixture-provider", choices: [{ index: 0, delta: { role: "assistant", content: "Anonymous " }, finish_reason: null }] })}\n\n`);
    if (hold) {
      await new Promise((resolve) => {
        const release = () => { waiting.delete(release); resolve(); };
        waiting.add(release);
        response.once("close", release);
      });
      if (response.destroyed) return;
    }
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: payload.model, choices: [{ index: 0, delta: { content: "Models are working." }, finish_reason: "stop" }] })}\n\n`);
    if (!missingUsage) response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: payload.model, provider: "fixture-provider", choices: [], usage })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(Number(process.env.ANONYMOUS_WITNESS_PORT ?? 8792), "0.0.0.0", resolve));
}

async function serveClientProxy() {
  const upstream = new URL(process.env.ANONYMOUS_CLIENT_UPSTREAM_URL ?? "http://127.0.0.1:8791");
  const mints = [];
  const inference = [];
  const unexpected = [];
  let currentToken = null;
  let rejectedToken = null;
  let failure = null;
  let nextSessionDelayMs = 0;
  let failNextSession = false;

  function json(response, status, value, headers = {}) {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(value));
  }

  async function body(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) throw new Error("Client proxy request exceeded fixture limit");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  function error(response, status, code, message) {
    json(response, status, { error: { code, message, type: status === 429 ? "rate_limit_error" : "api_error" } }, { "retry-after": "1" });
  }

  function responseHeaders(headers) {
    const output = {};
    for (const name of ["content-type", "cache-control", "retry-after", "x-request-id"]) {
      const value = headers.get(name);
      if (value) output[name] = value;
    }
    return output;
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fixture");
      if (url.pathname === "/health") return json(response, 200, { ok: true });
      if (request.method === "GET" && url.pathname === "/fixture/client/state") {
        return json(response, 200, { mints, inference, unexpected, failure, currentToken: Boolean(currentToken), rejectedToken: Boolean(rejectedToken) });
      }
      if (request.method === "POST" && url.pathname === "/fixture/client/expire") {
        rejectedToken = currentToken;
        return json(response, 200, { expired: Boolean(rejectedToken) });
      }
      const bytes = await body(request);
      let payload = {};
      try { payload = bytes.length ? JSON.parse(bytes.toString("utf8")) : {}; }
      catch { return json(response, 400, { error: "invalid fixture JSON" }); }
      if (request.method === "POST" && url.pathname === "/fixture/client/failure") {
        failure = ["limit", "capacity", "unavailable"].includes(payload.failure) ? payload.failure : null;
        return json(response, 200, { failure });
      }
      if (request.method === "POST" && url.pathname === "/fixture/client/session") {
        nextSessionDelayMs = Math.min(5_000, Math.max(0, Number(payload.delayMs) || 0));
        failNextSession = payload.fail === true;
        return json(response, 200, { nextSessionDelayMs, failNextSession });
      }

      const isSession = request.method === "POST" && url.pathname === "/api/anonymous/session";
      const isChat = request.method === "POST" && url.pathname === "/api/anonymous/v1/chat/completions";
      if (!isSession && !isChat) unexpected.push(`${request.method ?? "GET"} ${url.pathname}`);
      const authorization = request.headers.authorization ?? null;
      const bodyHash = createHash("sha256").update(bytes).digest("hex");
      if (isChat && rejectedToken && authorization === `Bearer ${rejectedToken}`) {
        inference.push({ status: 401, bodyHash, faulted: true });
        return error(response, 401, "invalid_anonymous_token", "The guest token is invalid");
      }
      if (isChat && failure) {
        const status = failure === "unavailable" ? 503 : 429;
        const code = failure === "limit" ? "anonymous_limit_exceeded" : failure === "capacity" ? "anonymous_capacity_exceeded" : "anonymous_unavailable";
        inference.push({ status, bodyHash, faulted: true });
        return error(response, status, code, "Injected anonymous client failure");
      }
      if (isSession && nextSessionDelayMs > 0) {
        const delayMs = nextSessionDelayMs;
        nextSessionDelayMs = 0;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (isSession && failNextSession) {
        failNextSession = false;
        return error(response, 503, "anonymous_unavailable", "Injected anonymous session failure");
      }

      const target = new URL(`${url.pathname}${url.search}`, upstream);
      const controller = new AbortController();
      request.once("aborted", () => controller.abort());
      const upstreamResponse = await fetch(target, {
        method: request.method,
        headers: {
          ...(authorization ? { authorization } : {}),
          ...(request.headers["content-type"] ? { "content-type": request.headers["content-type"] } : {}),
          ...(request.headers.accept ? { accept: request.headers.accept } : {}),
        },
        body: bytes.length ? bytes : undefined,
        signal: controller.signal,
      });
      if (isSession) {
        const responseBytes = Buffer.from(await upstreamResponse.arrayBuffer());
        let result = {};
        try { result = JSON.parse(responseBytes.toString("utf8")); } catch {}
        if (upstreamResponse.ok && typeof result.token === "string") {
          currentToken = result.token;
          mints.push({
            installationId: String(payload.installationId ?? ""),
            tokenHash: createHash("sha256").update(result.token).digest("hex"),
          });
        }
        response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse.headers));
        response.end(responseBytes);
        return;
      }
      if (isChat) {
        let code = null;
        let message = null;
        if (!upstreamResponse.ok) {
          try {
            const result = await upstreamResponse.clone().json();
            code = typeof result?.error?.code === "string" ? result.error.code : typeof result?.error === "string" ? result.error : null;
            message = typeof result?.error?.message === "string" ? result.error.message : null;
          } catch {}
        }
        const tools = Array.isArray(payload.tools) ? payload.tools : [];
        const messages = Array.isArray(payload.messages) ? payload.messages : [];
        inference.push({
          status: upstreamResponse.status,
          bodyHash,
          faulted: false,
          code,
          message,
          model: payload.model,
          maxTokens: payload.max_tokens,
          stream: payload.stream === true,
          toolChoice: payload.tool_choice,
          toolCount: tools.length,
          requestedToolNames: tools.map((tool) => tool?.function?.name).filter((name) => typeof name === "string"),
          canonicalBytes: bytes.length,
          topLevelFields: Object.keys(payload).sort(),
          toolFieldSets: [...new Set(tools.map((tool) => tool && typeof tool === "object" ? Object.keys(tool).sort().join(",") : typeof tool))],
          functionFieldSets: [...new Set(tools.map((tool) => tool?.function && typeof tool.function === "object" ? Object.keys(tool.function).sort().join(",") : typeof tool?.function))],
          messageFieldSets: [...new Set(messages.map((entry) => entry && typeof entry === "object" ? Object.keys(entry).sort().join(",") : typeof entry))],
        });
      }
      response.writeHead(upstreamResponse.status, responseHeaders(upstreamResponse.headers));
      if (!upstreamResponse.body) return response.end();
      Readable.fromWeb(upstreamResponse.body).pipe(response);
    })().catch((caught) => {
      unexpected.push(caught instanceof Error ? caught.message : String(caught));
      if (!response.headersSent) error(response, 502, "anonymous_unavailable", "Client proxy failed");
      else response.destroy(caught instanceof Error ? caught : undefined);
    });
  });
  await new Promise((resolve) => server.listen(Number(process.env.ANONYMOUS_CLIENT_PROXY_PORT ?? 8800), "0.0.0.0", resolve));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "witness") await serveWitness();
  else if (process.argv[2] === "client-proxy") await serveClientProxy();
  else {
    await arrange(process.argv[2], process.argv[3], process.argv[4]);
    process.exit(0);
  }
}
