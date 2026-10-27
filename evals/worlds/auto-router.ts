import { randomUUID } from "node:crypto";
import type { Seed } from "@openwork/env";
import { ACME_MODEL, gatewayEnvironment, seedAcmeGateway, startAcmeGateway, startAcmeUpstream } from "../../worlds/lib/acme-gateway.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";
import { isRecord } from "./library.ts";

/**
 * Auto Router: a real Den (cloud deployment, `autoRouter` on for the seeded
 * organization), a real AI Gateway with one Anthropic-protocol provider whose
 * only upstream is the deterministic Acme mock, and the owner signed in on
 * AI Gateway › AI Providers. Jev is real when TYPESAFE_API_KEY is set in the
 * test's environment; otherwise Auto takes its fallback route.
 */
export async function autoRouterWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const upstream = await startAcmeUpstream(stack);
    const gateway = await gatewayEnvironment(upstream.baseUrl);
    const typesafe = process.env.TYPESAFE_API_KEY?.trim();
    const env = { ...gateway.env, DEN_DEPLOYMENT: "cloud", ...(typesafe ? { TYPESAFE_API_KEY: typesafe } : {}) };
    const den = stack.use(await seed.den({ env, org: { name: "Auto Router proof", admin: { name: "Router owner" } } }));
    if (!den.database) throw new Error("The Auto Router world needs its disposable local database.");
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
 * Auto Router on the desktop: the same real Den (cloud, `autoRouter` on) and
 * real AI Gateway over the deterministic Acme upstream, with one Auto route
 * saved by the admin through Den's API, and the app in headless Chrome
 * signed in as that admin on the native v2 engine. The desktop learns Auto
 * from Den like any organization model and chats through the gateway.
 */
export async function autoRouterDesktopWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const upstream = await startAcmeUpstream(stack);
    const gateway = await gatewayEnvironment(upstream.baseUrl);
    const typesafe = process.env.TYPESAFE_API_KEY?.trim();
    const env = { ...gateway.env, DEN_DEPLOYMENT: "cloud", ...(typesafe ? { TYPESAFE_API_KEY: typesafe } : {}) };
    const { den, webPort } = await denForAppWeb(seed, { env, web: false, org: { name: "Auto Router desktop proof", admin: { name: "Router owner" } } });
    stack.use(den);
    if (!den.database) throw new Error("The Auto Router desktop world needs its disposable local database.");
    await startAcmeGateway(stack, den.database.url, { baseUrl: gateway.baseUrl, env });
    const provider = await seedAcmeGateway(den.admin, upstream);
    const organizationId = await enableOrganizationCapabilities(seed, den.admin, { autoRouter: true, liveProviderSync: true });
    const options = await seed.api(den.admin, "/v1/org/auto-router/options");
    const option = isRecord(options.body) && Array.isArray(options.body.options)
      ? options.body.options.filter(isRecord).find((entry) => entry.modelId === ACME_MODEL)
      : undefined;
    const offered = Array.isArray(option?.thinkingLevels) ? option.thinkingLevels.filter((level): level is string => typeof level === "string") : [];
    if (!options.response.ok || typeof option?.providerId !== "string") throw new Error(`Auto Router options are missing the Acme model: HTTP ${options.response.status}`);
    // One route at one non-default level, so the answered-by label shows a thinking level.
    const thinking = offered.includes("high") ? "high" : offered.find((level) => level !== "default") ?? "default";
    const saved = await seed.api(den.admin, "/v1/org/auto-router", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, routes: [{ providerId: option.providerId, modelId: ACME_MODEL, prompt: "Everyday questions, small edits and short answers", thinkingLevels: [thinking] }] }),
    });
    if (!saved.response.ok) throw new Error(`Saving the Auto route failed: HTTP ${saved.response.status} ${saved.text.slice(0, 300)}`);
    // The host token lets the app's server sync the organization's models (Auto among them) from Den.
    const hostToken = randomUUID();
    const { app, workspace } = await signedInAppWeb(seed, {
      env: { OPENWORK_HOST_TOKEN: hostToken, VITE_OPENWORK_HOST_TOKEN: hostToken },
      den, webPort, name: "auto-router-desktop", headless: true, engine: "v2",
      workspacePath: seed.tmpPath("auto-router-desktop"),
    });
    const session = await seed.session(app, { title: "Auto chat" });
    return {
      den,
      app,
      workspace,
      session,
      organizationId,
      upstream,
      thinking,
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
