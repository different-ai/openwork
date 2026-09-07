/** Test-only payer preconditions and upstream witness. Never mounts on Den. */
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
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
        calls.push({ model: String(payload.model), authenticated: req.headers.authorization === `Bearer ${fixtureUpstreamKey}`, kind: error ? "error" : missing ? "incomplete" : "success" });
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
