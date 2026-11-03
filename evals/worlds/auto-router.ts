import { randomUUID } from "node:crypto";
import type { Seed } from "@openwork/env";
import { ACME_MODEL, gatewayEnvironment, seedAcmeGateway, startAcmeGateway, startAcmeUpstream } from "../../worlds/lib/acme-gateway.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";
import { isRecord } from "./library.ts";

/**
 * The gateway's Jev settings. A real TYPESAFE_API_KEY in the test's
 * environment is used as is. Otherwise the gateway gets a placeholder key and
 * an unreachable TypeSafe URL: routing counts as configured, every Jev call
 * fails at once, and Smart takes its fallback model without leaving the machine.
 */
function jevEnvironment(typesafe: string | undefined): Record<string, string> {
  return typesafe ? { TYPESAFE_API_KEY: typesafe } : { TYPESAFE_API_KEY: "auto-router-proof-placeholder", TYPESAFE_BASE_URL: "http://127.0.0.1:9" };
}

/**
 * Smart Model Router: a real Den (cloud deployment, `autoRouter` on for the
 * seeded organization), a real AI Gateway with one Anthropic-protocol provider
 * whose only upstream is the deterministic Acme mock, and the owner signed in
 * on AI Gateway › AI Providers, where Smart Routers are listed. Jev is real when TYPESAFE_API_KEY is set
 * in the test's environment; otherwise Smart takes its fallback model.
 */
export async function autoRouterWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const upstream = await startAcmeUpstream(stack);
    const gateway = await gatewayEnvironment(upstream.baseUrl);
    const typesafe = process.env.TYPESAFE_API_KEY?.trim();
    const env = { ...gateway.env, DEN_DEPLOYMENT: "cloud", ...jevEnvironment(typesafe) };
    const den = stack.use(await seed.den({ env, org: { name: "Smart Router proof", admin: { name: "Router owner" } } }));
    if (!den.database) throw new Error("The Smart Router world needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env });
    const provider = await seedAcmeGateway(den.admin, upstream);
    const organizationId = await enableOrganizationCapabilities(seed, den.admin, { autoRouter: true });
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/ai-gateway?tab=ai-providers", headless: true, viewport: { width: 1440, height: 1100 } });
    return {
      den,
      web,
      organizationId,
      provider,
      gatewayUrl: gateway.baseUrl,
      upstream,
      jev: Boolean(typesafe),
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}

/**
 * Smart Model Router when the AI Gateway has no TypeSafe key: the same real
 * Den and gateway with the feature on, but no routing key, and the owner on
 * AI Gateway › Smart Model Router.
 */
export async function autoRouterMissingKeyWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const upstream = await startAcmeUpstream(stack);
    const gateway = await gatewayEnvironment(upstream.baseUrl);
    const env = { ...gateway.env, DEN_DEPLOYMENT: "cloud" };
    const den = stack.use(await seed.den({ env, org: { name: "Smart Router setup proof", admin: { name: "Router owner" } } }));
    if (!den.database) throw new Error("The Smart Router world needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env });
    const provider = await seedAcmeGateway(den.admin, upstream);
    await enableOrganizationCapabilities(seed, den.admin, { autoRouter: true });
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/ai-gateway?tab=ai-providers", headless: true, viewport: { width: 1440, height: 1100 } });
    return {
      den,
      web,
      /** Asks Den to create a Smart Router through the API, as a script would; returns the HTTP status. */
      async tryCreate() {
        const result = await seed.api(den.admin, "/v1/org/auto-routers", {
          method: "POST",
          body: JSON.stringify({ name: "Everyone", models: [{ providerId: provider.providerId, modelId: ACME_MODEL, tasks: ["Questions"] }] }),
        });
        return result.response.status;
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}

/**
 * Smart Model Router on the desktop: the same real Den (cloud, `autoRouter`
 * on) and real AI Gateway over the deterministic Acme upstream, with one
 * Smart Router ("Engineering", for everyone, the Acme model with two tasks)
 * created and assigned by the admin through Den's API, and the app in headless Chrome signed
 * in as that admin on the native v2 engine. The desktop learns the Smart model
 * from Den like any organization model and chats through the gateway.
 */
export async function autoRouterDesktopWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const upstream = await startAcmeUpstream(stack);
    const gateway = await gatewayEnvironment(upstream.baseUrl);
    const typesafe = process.env.TYPESAFE_API_KEY?.trim();
    const env = { ...gateway.env, DEN_DEPLOYMENT: "cloud", ...jevEnvironment(typesafe) };
    const { den, webPort } = await denForAppWeb(seed, { env, web: false, org: { name: "Smart Router desktop proof", admin: { name: "Router owner" } } });
    stack.use(den);
    if (!den.database) throw new Error("The Smart Router desktop world needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env });
    const provider = await seedAcmeGateway(den.admin, upstream);
    const organizationId = await enableOrganizationCapabilities(seed, den.admin, { autoRouter: true });
    const options = await seed.api(den.admin, "/v1/org/auto-router/options");
    const option = isRecord(options.body) && Array.isArray(options.body.options)
      ? options.body.options.filter(isRecord).find((entry) => entry.modelId === ACME_MODEL)
      : undefined;
    if (!options.response.ok || typeof option?.providerId !== "string") throw new Error(`Smart Router options are missing the Acme model: HTTP ${options.response.status}`);
    const saved = await seed.api(den.admin, "/v1/org/auto-routers", {
      method: "POST",
      body: JSON.stringify({ name: "Engineering", models: [{ providerId: option.providerId, modelId: ACME_MODEL, tasks: ["Questions", "Geography"] }] }),
    });
    const routerId = isRecord(saved.body) && typeof saved.body.routerId === "string" ? saved.body.routerId : null;
    if (!saved.response.ok || !routerId) throw new Error(`Saving the Smart Router failed: HTTP ${saved.response.status} ${saved.text.slice(0, 300)}`);
    // Step two: it applies to everyone.
    const assigned = await seed.api(den.admin, `/v1/org/auto-routers/${routerId}/assignment`, {
      method: "PUT",
      body: JSON.stringify({ assignment: { everyone: true, teamIds: [], memberIds: [] } }),
    });
    if (!assigned.response.ok) throw new Error(`Assigning the Smart Router failed: HTTP ${assigned.response.status} ${assigned.text.slice(0, 300)}`);
    // The host token lets the app's server sync the organization's models (Smart among them) from Den.
    const hostToken = randomUUID();
    const { app, workspace } = await signedInAppWeb(seed, {
      env: { OPENWORK_HOST_TOKEN: hostToken, VITE_OPENWORK_HOST_TOKEN: hostToken },
      den, webPort, name: "auto-router-desktop", headless: true, engine: "v2",
      workspacePath: seed.tmpPath("auto-router-desktop"),
    });
    const session = await seed.session(app, { title: "Smart chat" });
    return {
      den,
      app,
      workspace,
      session,
      organizationId,
      upstream,
      routerId,
      routerName: "Engineering",
      modelName: typeof option.modelName === "string" ? option.modelName : ACME_MODEL,
      gatewayModelName: provider.modelName,
      jev: Boolean(typesafe),
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}
