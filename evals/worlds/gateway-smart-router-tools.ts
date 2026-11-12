import type { Seed } from "@openwork/env";
import { ACME_MODEL, gatewayEnvironment, seedAcmeGateway, startAcmeGateway, startAcmeUpstream } from "../../worlds/lib/acme-gateway.ts";
import { jevEnvironment } from "./auto-router.ts";
import { isRecord } from "./library.ts";

/**
 * Smart Routers in 3rd party tools: a real Den (cloud) and AI
 * Gateway with one Anthropic-protocol provider over the deterministic Acme mock,
 * 3rd party tools allowed, and one Smart Router ("Engineering", for everyone, the Acme model)
 * created and assigned through Den's API. Jev is real when TYPESAFE_API_KEY is set; otherwise the
 * gateway's Jev calls fail at once and Smart takes its fallback model. The owner is signed in on
 * My Library › Models.
 */
export async function gatewaySmartRouterToolsWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const upstream = await startAcmeUpstream(stack);
    const gateway = await gatewayEnvironment(upstream.baseUrl);
    const env = { ...gateway.env, DEN_DEPLOYMENT: "cloud", ...jevEnvironment(process.env.TYPESAFE_API_KEY?.trim()) };
    const den = stack.use(await seed.den({ env, org: { name: "Smart Router tools proof", admin: { name: "Router owner" } } }));
    if (!den.database) throw new Error("The Smart Router tools world needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env });
    const provider = await seedAcmeGateway(den.admin, upstream);
    const allowed = await seed.api(den.admin, "/v1/org/ai-gateway-settings", { method: "PUT", body: JSON.stringify({ memberApiKeys: true }) });
    if (!allowed.response.ok) throw new Error(`Allowing 3rd party tools failed: HTTP ${allowed.response.status} ${allowed.text.slice(0, 300)}`);
    const saved = await seed.api(den.admin, "/v1/org/auto-routers", {
      method: "POST",
      body: JSON.stringify({ name: "Engineering", models: [{ providerId: provider.providerId, modelId: ACME_MODEL, tasks: ["Questions", "Coding"] }] }),
    });
    const routerId = isRecord(saved.body) && typeof saved.body.routerId === "string" ? saved.body.routerId : null;
    if (!saved.response.ok || !routerId) throw new Error(`Saving the Smart Router failed: HTTP ${saved.response.status} ${saved.text.slice(0, 300)}`);
    const assigned = await seed.api(den.admin, `/v1/org/auto-routers/${routerId}/assignment`, {
      method: "PUT",
      body: JSON.stringify({ assignment: { everyone: true, teamIds: [], memberIds: [] } }),
    });
    if (!assigned.response.ok) throw new Error(`Assigning the Smart Router failed: HTTP ${assigned.response.status} ${assigned.text.slice(0, 300)}`);
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/library?show=models", headless: true, viewport: { width: 1440, height: 1100 } });
    return {
      den,
      web,
      routerId,
      upstream,
      gatewayUrl: gateway.baseUrl,
      /** A tool's request with the key as a bearer token (Cursor, Claude Code and Codex all send it so). */
      async call(key: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
        const response = await fetch(url, {
          method: body === undefined ? "GET" : "POST",
          headers: { authorization: `Bearer ${key}`, ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        const text = await response.text();
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { json = null; }
        return { status: response.status, json, text, headers: response.headers };
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
