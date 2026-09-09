/** Test-only payer preconditions and upstream witness. Never mounts on Den. */
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const fixtureUpstreamKey = "models-analytics-fixture-upstream";
export function modelsFixtureKey(memberId) { return `ow_inf_models-analytics-fixture-${memberId}`; }
async function arrange(command, orgId, inferenceUrl) {
    const { createDenDb } = await import("../../../../ee/packages/den-db/src/client.ts");
    const { db } = createDenDb({ databaseUrl: process.env.DATABASE_URL, mode: "mysql" });
    const schema = await import("../../../../ee/packages/den-db/src/schema.ts");
    const { and, eq, sql } = await import("../../../../ee/packages/den-db/src/drizzle.ts");
    const { createDenTypeId, normalizeDenTypeId } = await import("../../../../ee/packages/utils/src/typeid.ts");
    const id = normalizeDenTypeId("organization", orgId);
    if (command === "before-migration") {
        // This world owns a fresh disposable database with no analytics data.
        await db.execute(sql.raw("DROP TABLE models_analytics_event"));
        await db.execute(sql.raw("DROP TABLE models_analytics_settings"));
    }
    else if (command === "migrate") {
        const migration = await readFile(new URL("../../../../ee/packages/den-db/drizzle/0092_models_task_analytics.sql", import.meta.url), "utf8");
        for (const statement of migration.split("--> statement-breakpoint")) {
            if (statement.trim()) await db.execute(sql.raw(statement.trim()));
        }
    }
    else if (command === "assert-erased") {
        const settings = await db.select({ id: schema.ModelsAnalyticsSettingsTable.org_id }).from(schema.ModelsAnalyticsSettingsTable).where(eq(schema.ModelsAnalyticsSettingsTable.org_id, id)).limit(1);
        const events = await db.select({ id: schema.ModelsAnalyticsEventTable.id }).from(schema.ModelsAnalyticsEventTable).where(eq(schema.ModelsAnalyticsEventTable.org_id, id)).limit(1);
        if (settings.length || events.length) throw new Error("Deleted workspace still retains analytics history or integration credentials");
    }
    else if (command === "pause-analytics") {
        await db.execute(sql.raw("RENAME TABLE models_analytics_event TO models_analytics_event_unavailable"));
    }
    else if (command === "resume-analytics") {
        await db.execute(sql.raw("RENAME TABLE models_analytics_event_unavailable TO models_analytics_event"));
    }
    else if (command === "subscription") {
        await db.insert(schema.OrgSubscriptionTable).values({
            id: createDenTypeId("orgSubscription"), organization_id: id, type: "inference", status: "active",
            stripe_customer_id: `cus_fixture_${orgId}`, stripe_subscription_id: `sub_fixture_${orgId}`, quantity: 2,
        });
        await db.insert(schema.InferenceOrgUpstreamProviderKeyTable).values({
            id: createDenTypeId("inferenceOrgProviderKey"), organization_id: id, provider: "openrouter", encrypted_api_key: fixtureUpstreamKey, status: "active",
        });
    }
    else if (command === "configure") {
        const providers = await db.select().from(schema.LlmProviderTable).where(and(eq(schema.LlmProviderTable.organizationId, id), eq(schema.LlmProviderTable.source, "openwork")));
        for (const provider of providers) {
            const key = modelsFixtureKey(provider.createdByOrgMembershipId);
            await db.update(schema.LlmProviderTable).set({ apiKey: key, providerConfig: {
                    ...provider.providerConfig, api: `${inferenceUrl}/api/v1`, options: { baseURL: `${inferenceUrl}/api/v1` },
                } }).where(eq(schema.LlmProviderTable.id, provider.id));
            await db.update(schema.InferenceKeyTable).set({ key_hash: createHash("sha256").update(key).digest("hex") }).where(and(eq(schema.InferenceKeyTable.organization_id, id), eq(schema.InferenceKeyTable.org_membership_id, provider.createdByOrgMembershipId), eq(schema.InferenceKeyTable.status, "active")));
        }
    }
    else if (command === "cancel") {
        await db.update(schema.OrgSubscriptionTable).set({ status: "canceled" }).where(and(eq(schema.OrgSubscriptionTable.organization_id, id), eq(schema.OrgSubscriptionTable.type, "inference")));
    }
    else if (command === "restore") {
        await db.update(schema.OrgSubscriptionTable).set({ status: "active" }).where(and(eq(schema.OrgSubscriptionTable.organization_id, id), eq(schema.OrgSubscriptionTable.type, "inference")));
    }
    else
        throw new Error("Unknown Models fixture command");
    console.log("Models fixture ready");
}
async function serveWitness() {
    const calls = [];
    const exports = [];
    let holdExport = false;
    let releaseExport = null;
    const stripeRequests = [];
    let holdStripe = false;
    let releaseStripe = null;
    let dpa = null;
    const usageFixture = process.env.MODELS_USAGE_FIXTURE === "1"
        ? await (await import("./paid-usage-fixture.mjs")).paidUsageFixture() : null;
    if (process.env.MODELS_DPA_FIXTURE === "1") {
        const url = new URL(process.env.DATABASE_URL);
        if (url.hostname !== "127.0.0.1" || !/^\/(openwork_eval_|openwork_den$)/.test(url.pathname)) throw new Error("DPA witness requires an isolated testkit database");
        const { createConnection } = createRequire(new URL("../../env/package.json", import.meta.url))("mysql2/promise");
        const connection = await createConnection(process.env.DATABASE_URL);
        const lock = await createConnection(process.env.DATABASE_URL);
        const orgId = process.env.MODELS_DPA_ORG_ID;
        const [rows] = await connection.execute("SELECT metadata FROM organization WHERE id = ?", [orgId]);
        const metadata = typeof rows[0].metadata === "string" ? JSON.parse(rows[0].metadata) : rows[0].metadata;
        const baseline = { ...metadata, plan: { tier: "enterprise", source: "manual" }, fixtureNested: { keep: { value: "unchanged" } } };
        await connection.execute("UPDATE organization SET metadata = ? WHERE id = ?", [JSON.stringify(baseline), orgId]);
        dpa = async (action, input) => {
            if (action === "metadata") {
                const value = input.mode === "restore" ? baseline : input.mode === "string-true" ? JSON.stringify({ ...baseline, dpaSigned: true }) : input.mode === "nonboolean" ? { ...baseline, dpaSigned: "true" } : input.value;
                await connection.execute("UPDATE organization SET metadata = ? WHERE id = ?", [JSON.stringify(value), orgId]);
            } else if (action === "hold") {
                await lock.query("LOCK TABLES inference_org_limit_policies WRITE");
            } else if (action === "release") {
                await lock.query("UNLOCK TABLES");
            } else if (action === "read-failure") {
                await connection.query("ALTER TABLE organization RENAME COLUMN metadata TO fixture_metadata_unavailable");
            } else if (action === "read-restore") {
                await connection.query("ALTER TABLE organization RENAME COLUMN fixture_metadata_unavailable TO metadata");
            } else if (action === "audit-failure") {
                await connection.query("ALTER TABLE audit_event RENAME COLUMN payload TO fixture_payload_unavailable");
            } else if (action === "audit-restore") {
                await connection.query("ALTER TABLE audit_event RENAME COLUMN fixture_payload_unavailable TO payload");
            } else if (action === "rename-managed") {
                await connection.execute("UPDATE llm_provider SET name = 'Customer-looking renamed provider' WHERE organization_id = ? AND source = 'openwork'", [orgId]);
            } else if (action === "stripe-hold") {
                holdStripe = true;
            } else if (action === "stripe-release") {
                holdStripe = false;
                releaseStripe?.();
                releaseStripe = null;
            } else if (action === "remove-member-access") {
                // Arrange missing access for the non-admin member, never for the warm test key.
                await connection.execute("UPDATE inference_keys SET status = 'revoked' WHERE organization_id = ? AND org_membership_id = ?", [orgId, input.memberId]);
                await connection.execute("DELETE FROM llm_provider WHERE organization_id = ? AND created_by_org_membership_id = ? AND source = 'openwork'", [orgId, input.memberId]);
            } else if (action !== "state") throw new Error("Unknown DPA witness action");
            if (action !== "state") return { ok: true };
            const [organizations] = await connection.execute("SELECT metadata FROM organization WHERE id = ?", [orgId]);
            const stored = typeof organizations[0].metadata === "string" ? JSON.parse(organizations[0].metadata) : organizations[0].metadata;
            const [audits] = await connection.execute("SELECT id, actor_user_id AS actorUserId, action, payload FROM audit_event WHERE org_id = ? AND action = 'organization.dpa_signed.updated' ORDER BY created_at, id", [orgId]);
            const [keys] = await connection.execute("SELECT org_membership_id AS memberId, status FROM inference_keys WHERE organization_id = ? ORDER BY id", [orgId]);
            const [providers] = await connection.execute("SELECT id, created_by_org_membership_id AS memberId, source, name FROM llm_provider WHERE organization_id = ? ORDER BY id", [orgId]);
            const [subscriptions] = await connection.execute("SELECT type, status, quantity, last_event_id AS lastEventId FROM org_subscriptions WHERE organization_id = ? ORDER BY id", [orgId]);
            const [pending] = await connection.query("SELECT COUNT(*) AS count FROM information_schema.processlist WHERE ID <> CONNECTION_ID() AND INFO LIKE 'select%inference_org_limit_policies%' AND STATE LIKE '%lock%'");
            const egress = await readFile(process.env.MODELS_EGRESS_FILE, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
            return { metadata: stored, audits: audits.map((row) => ({ ...row, payload: typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload })), keys, providers, subscriptions, stripeRequests, stripeInFlight: releaseStripe !== null, waitingForLimits: Number(pending[0].count) > 0, egress: egress.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
        };
    }
    const upstream = createServer(async (req, res) => {
        if (req.url === "/fixture/requests") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ calls, exports, exportInFlight: releaseExport !== null }));
            return;
        }
        if (req.url === "/fixture/export-hold") { holdExport = true; res.end("{}"); return; }
        if (req.url === "/fixture/export-release") { releaseExport?.(); releaseExport = null; holdExport = false; res.end("{}"); return; }
        let text = "";
        for await (const chunk of req) {
            text += chunk.toString();
            if (text.length > 2_000_000) {
                res.writeHead(413).end();
                return;
            }
        }
        if (dpa && req.url?.startsWith("/fixture/dpa/")) {
            try {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify(await dpa(req.url.slice("/fixture/dpa/".length), text ? JSON.parse(text) : {})));
            } catch (error) {
                res.writeHead(500).end(JSON.stringify({ error: String(error.message) }));
            }
            return;
        }
        if (usageFixture && req.url?.startsWith("/fixture/usage/")) {
            try {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify(await usageFixture(req.url.slice("/fixture/usage/".length), text ? JSON.parse(text) : {})));
            } catch (error) { res.writeHead(500).end(JSON.stringify({ error: error.message })); }
            return;
        }
        if (dpa && req.url?.startsWith("/stripe/")) {
            const authenticated = req.headers.authorization === "Bearer sk_test_models_dpa_fixture_not_real";
            const path = new URL(req.url, "http://fixture.test").pathname.slice("/stripe".length);
            stripeRequests.push({ method: req.method, path, authenticated });
            res.setHeader("content-type", "application/json");
            if (!authenticated) { res.writeHead(401).end("{}"); return; }
            const orgId = process.env.MODELS_DPA_ORG_ID;
            const metadata = { org_id: orgId, subscription_type: "inference" };
            const subscription = {
                id: `sub_fixture_${orgId}`, object: "subscription", customer: `cus_fixture_${orgId}`, status: "active", metadata,
                items: { object: "list", data: [{ id: "si_fixture_dpa", quantity: 7, price: { id: "price_fixture_dpa" } }] },
                cancel_at_period_end: false, current_period_start: 1788825600, current_period_end: 1791417600,
            };
            if (req.method === "GET" && path === "/v1/checkout/sessions/cs_fixture_dpa") {
                if (holdStripe) await new Promise((resolve) => { releaseStripe = resolve; });
                res.end(JSON.stringify({ id: "cs_fixture_dpa", object: "checkout.session", status: "complete", mode: "subscription", payment_status: "paid", subscription: subscription.id, metadata }));
            } else if (req.method === "GET" && path === `/v1/subscriptions/${subscription.id}`) {
                res.end(JSON.stringify(subscription));
            } else if (req.method === "DELETE" && path === `/v1/subscriptions/${subscription.id}`) {
                res.end(JSON.stringify({ ...subscription, status: "canceled" }));
            } else {
                res.writeHead(400).end(JSON.stringify({ error: { message: "Unexpected fixture Stripe operation", type: "invalid_request_error" } }));
            }
            return;
        }
        if (req.url === "/api/public/otel/v1/traces") {
            if (req.headers.authorization !== `Basic ${Buffer.from("fixture-public:fixture-secret").toString("base64")}`) {
                res.writeHead(401).end();
                return;
            }
            exports.push(JSON.parse(text));
            if (holdExport && JSON.parse(text).resourceSpans.some((resource) => resource.scopeSpans.some((scope) => scope.spans.length))) {
                await new Promise((resolve) => { releaseExport = resolve; });
            }
            res.setHeader("content-type", "application/json");
            res.end("{}");
            return;
        }
        const payload = JSON.parse(text);
        const latest = payload.messages?.findLast((message) => message.role === "user");
        const prompt = JSON.stringify(latest?.content ?? "");
        const error = prompt.includes("fixture:error");
        const missing = prompt.includes("fixture:missing-usage");
        const byok = req.url === "/byok/chat/completions";
        const authenticated = req.headers.authorization === `Bearer ${byok ? "fixture-customer-owned-key" : fixtureUpstreamKey}`;
        calls.push({ model: String(payload.model), authenticated, ...(dpa ? { route: byok ? "byok" : "managed" } : {}), ...(usageFixture ? { trace: payload.trace } : {}), kind: error ? "error" : missing ? "incomplete" : "success" });
        if (dpa && !authenticated) { res.writeHead(401).end("{}"); return; }
        if (error) {
            res.writeHead(503, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Fixture upstream unavailable" } }));
            return;
        }
        const id = `chatcmpl-${randomUUID()}`;
        const model = payload.model;
        const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_tokens_details: { cached_tokens: 20 }, cost: 0.0123 };
        const content = "Models are working.";
        const requestedSkill = prompt.includes("Load the analytics fixture skill");
        const hasSkillResult = payload.messages.some((message) => message.role === "tool" && message.tool_call_id === "analytics-fixture-skill-call");
        const useSkill = requestedSkill && !hasSkillResult;
        if (useSkill && !["skill", "glob"].every((name) => payload.tools?.some((tool) => tool.function?.name === name))) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "Fixture task requires the native skill and glob tools" } })); return;
        }
        if (!payload.stream) {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ id, model, provider: "FixtureProvider", choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], ...(missing ? {} : { usage }) }));
            return;
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frames = useSkill ? [
            { id, object: "chat.completion.chunk", model, provider: "FixtureProvider", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [
                { index: 0, id: "analytics-fixture-skill-call", type: "function", function: { name: "skill", arguments: JSON.stringify({ name: "analytics-fixture" }) } },
                { index: 1, id: "analytics-fixture-glob-call", type: "function", function: { name: "glob", arguments: JSON.stringify({ pattern: "**/SKILL.md", path: "." }) } },
            ] }, finish_reason: "tool_calls" }] },
            { id, object: "chat.completion.chunk", model, provider: "FixtureProvider", choices: [], usage },
        ] : [
            { id, object: "chat.completion.chunk", model, provider: "FixtureProvider", choices: [{ index: 0, delta: { role: "assistant", content: "Models are " }, finish_reason: null }] },
            { id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: { content: "working." }, finish_reason: "stop" }] },
            ...(!missing ? [{ id, object: "chat.completion.chunk", model, provider: "FixtureProvider", choices: [], usage }] : []),
        ];
        for (const frame of frames) {
            const data = `data: ${JSON.stringify(frame)}\n\n`;
            // Deliberately split inside a JSON frame, exercising real stream framing.
            res.write(data.slice(0, 13));
            await new Promise((resolve) => setTimeout(resolve, 30));
            res.write(data.slice(13));
        }
        res.end("data: [DONE]\n\n");
    });
    await new Promise((resolve) => upstream.listen(Number(process.env.MODELS_WITNESS_PORT ?? 8792), "0.0.0.0", resolve));
    await import("../../../../ee/apps/inference/src/server.ts");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (process.argv[2] === "serve")
        await serveWitness();
    else {
        await arrange(process.argv[2], process.argv[3], process.argv[4]);
        process.exit(0);
    }
}
