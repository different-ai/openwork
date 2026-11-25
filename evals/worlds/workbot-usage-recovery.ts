import { freeInferenceWindow } from "@openwork/types/den/inference";
import { workbotAccessFixture } from "../../ee/apps/workbot/scripts/workbot-access-fixture.ts";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { z } from "zod";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import { createHeadlessRunnerClient } from "../../ee/packages/headless-protocol/src/client.ts";
import { createWorkbot, type WorkbotActor } from "../../ee/packages/workbot-server/src/service.ts";
import { modelProbeFixture, type ProbeFixtureMode } from "../../ee/apps/headless-runner/scripts/model-probe-fixture.ts";

/** Real UI, runner, model adapter and transcript projection. Only Den identity/options and upstream replies are synthetic. */
export async function workbotUsageRecovery(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  const freeResetsAt = freeInferenceWindow().end.toISOString();
  try {
    const cases = new Map<string, { workbot: ReturnType<typeof createWorkbot>; actor: WorkbotActor; runner: Awaited<ReturnType<typeof modelProbeFixture>>; attempts: number; error: string | null; retryable: boolean }>();
    for (const [key, mode] of new Map<string, ProbeFixtureMode>([["free", "free_limit"], ["reset", "free_limit"], ["usage", "usage_limit"], ["allowance", "models_allowance"], ["payment", "payment_required"], ["temporary", "rate_limited"], ["access", "answered"], ["provider", "answered"]])) {
      const runner = await modelProbeFixture({ basePath: "/api/v1", protocol: "openai-responses", answer: "Your conversation is still here." });
      resources.defer(() => runner.close());
      const client = createHeadlessRunnerClient({ config: { url: runner.url, token: "r".repeat(32) }, fetch, mintToken: async () => ({ token: "fixture-mcp-token" }), maxTokenTtlMs: 60_000 });
      const workbot = createWorkbot({ client, canSchedule: async () => false });
      const actor: WorkbotActor = { organizationId: "org_recovery", memberId: `member_${key}`, userId: `user_${key}`, firstName: "Alex", organizationName: "Recovery workspace", organizationMetadata: {} };
      const settled = async () => {
        for (let attempt = 0; attempt < 200; attempt++) {
          const thread = await workbot.readThread(actor);
          if (thread.turns.length && thread.turns.at(-1)?.status !== "working" && thread.turns.at(-1)?.status !== "queued") return thread;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error("Recovery fixture turn did not settle");
      };
      await workbot.send(actor, { id: "message_earlier", text: "Keep our earlier work" });
      await settled();
      runner.setMode(mode);
      const before = runner.calls().length;
      if (key !== "access" && key !== "provider") await workbot.send(actor, { id: "message_limited", text: "Continue my work" });
      const thread = await settled();
      cases.set(key, { workbot, actor, runner, attempts: runner.calls().length - before, error: thread.turns.at(-1)?.error ?? null, retryable: thread.turns.at(-1)?.retryable ?? false });
    }
    // Real Workbot HTTP -> Den client -> runner. Only Den's outside identity/grant response is synthetic.
    const access = cases.get("access");
    if (!access) throw new Error("Missing access fixture");
    let accessInput: { id: string; text: string } | null = null;
    const accessServer = await workbotAccessFixture({ actor: access.actor, runnerUrl: access.runner.url, modelAccess: access.runner.modelAccess });
    resources.defer(() => accessServer.close());
    const sendAccess = accessServer.send;
    // Managed models unavailable by entitlement/policy and no Gateway provider: Den refuses before any model call.
    const provider = cases.get("provider");
    if (!provider) throw new Error("Missing provider fixture");
    const providerServer = await workbotAccessFixture({ actor: provider.actor, runnerUrl: provider.runner.url, modelAccess: provider.runner.modelAccess, refusal: "gateway_provider_missing" });
    resources.defer(() => providerServer.close());
    const free = cases.get("free");
    if (!free) throw new Error("Missing free fixture");
    const managedServer = await workbotAccessFixture({ actor: free.actor, runnerUrl: free.runner.url, modelAccess: free.runner.modelAccess, managed: true });
    resources.defer(() => managedServer.close());
    let modelsActivated = false;
    let managedInput: { id: string; text: string } | null = null;
    let paidStart = 0;
    const vite = await createServer({
      configFile: fileURLToPath(new URL("../../ee/apps/workbot/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
      plugins: [{ name: "workbot-recovery-fixture", configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = new URL(req.url ?? "/", "http://fixture");
          if (!url.pathname.startsWith("/v1/workbot")) return next();
          void (async () => {
            const page = new URL(req.headers.referer ?? "http://fixture");
            const key = page.searchParams.get("issue") ?? "free";
            const entry = cases.get(key);
            if (!entry) throw new Error("Unknown recovery fixture");
            const owner = page.searchParams.get("persona") !== "member";
            const subscribed = page.searchParams.get("persona") === "subscriber" || modelsActivated && key === "free";
            const json = (body: unknown) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
            if (url.pathname === "/v1/workbot/me") return json({ name: "Alex", email: "alex@example.test", userId: entry.actor.userId, organizationId: entry.actor.organizationId, organizationName: "Recovery workspace", enabled: true, calendar: false, sideChats: false, denUrl: "https://den.example.test" });
            const canPurchase = owner && page.searchParams.get("persona") !== "models-admin";
            if (url.pathname === "/v1/workbot/model-recovery") return json({ canUpgrade: canPurchase && key === "free" && !subscribed, purchaseEligible: canPurchase && key === "free" && !subscribed, managedLuna: key === "free" || key === "provider", hasModelsSubscription: subscribed, paidContinuation: key === "free" && modelsActivated ? "authorized" : canPurchase && key === "free" && !subscribed ? "after_upgrade" : "unavailable", upgradeBlockedReason: key === "free" && (modelsActivated || canPurchase && !subscribed) ? null : "paid_workbot_route_unavailable", canManageModels: owner, canManageBilling: owner, freeExhausted: key === "free" && !page.searchParams.has("cleared"), freeResetsAt: key === "free" ? freeResetsAt : null });
            if (url.pathname === "/v1/workbot") return json({ available: true, ...await entry.workbot.readThread(entry.actor) });
            if (url.pathname === "/v1/workbot/events") { res.setHeader("content-type", "text/event-stream"); res.end(": fixture\n\n"); return; }
            if (url.pathname === "/v1/workbot/messages/message_limited/retry" && req.method === "POST") {
              if (page.searchParams.has("cleared")) entry.runner.setMode("answered");
              return json(await entry.workbot.retry(entry.actor, { id: "message_limited" }));
            }
            if (url.pathname === "/v1/workbot/messages" && req.method === "POST") {
              let body = ""; for await (const chunk of req) body += chunk;
              const input = z.object({ id: z.string(), text: z.string() }).parse(JSON.parse(body));
              if (key === "free") {
                managedInput = input;
                const result = await managedServer.send(input);
                res.statusCode = result.status;
                return json(await result.json());
              }
              if (key === "provider") {
                const result = await providerServer.send(input);
                res.statusCode = result.status;
                return json(await result.json());
              }
              if (key === "access") {
                accessInput = input;
                const result = await sendAccess(input);
                res.statusCode = result.status;
                return json(await result.json());
              }
              return json(await entry.workbot.send(entry.actor, input));
            }
            res.statusCode = 404; json({ error: "not_found" });
          })().catch(() => { res.statusCode = 500; res.end("Fixture request failed"); });
        });
      } }],
    });
    resources.defer(() => vite.close());
    await vite.listen();
    const url = vite.resolvedUrls?.local[0];
    if (!url) throw new Error("Recovery UI did not start");
    const web = resources.use(await chrome({ host: place.host(), name: "workbot-usage-recovery", startUrl: url, headless: true }));
    return { web, url, witness: (key: string) => ({ attempts: cases.get(key)?.attempts, retryable: cases.get(key)?.retryable }),
      activateModels: () => { modelsActivated = true; paidStart = free.runner.calls().length; managedServer.restore(); free.runner.setMode("answered"); },
      async managedRecovery() {
        const turns = (await free.workbot.readThread(free.actor)).turns;
        const matches = turns.filter(turn => turn.id === managedInput?.id);
        const calls = free.runner.calls().slice(paidStart);
        return { copies: matches.length, status: matches[0]?.status, earlier: turns.some(turn => turn.id === "message_earlier"), calls: calls.length,
          paidPath: calls[0]?.path, upstreamModel: z.object({ model: z.string() }).safeParse(calls[0]?.body).data?.model };
      },
      async repeatManagedSend() { if (!managedInput) throw new Error("No paid continuation"); return (await managedServer.send(managedInput)).status; },
      restorePaidAccess: () => accessServer.restore(),
      accessCalls: () => access.runner.calls().length - 1,
      providerCalls: () => provider.runner.calls().length - 1,
      async paidRecovery() {
        const turns = (await access.workbot.readThread(access.actor)).turns;
        const matches = turns.filter(turn => turn.id === accessInput?.id);
        return { copies: matches.length, status: matches[0]?.status, earlier: turns.some(turn => turn.id === "message_earlier"), calls: access.runner.calls().length - 1 };
      },
      async repeatPaidSend() { if (!accessInput) throw new Error("No pending access message"); return (await sendAccess(accessInput)).status; },
      async recoveredTurn() {
        const entry = cases.get("reset");
        if (!entry) throw new Error("Missing reset fixture");
        const turns = (await entry.workbot.readThread(entry.actor)).turns.filter(turn => turn.id === "message_limited");
        return { copies: turns.length, status: turns[0]?.status };
      },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); } };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
