import { denFetch } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { isolatedRedis } from "./isolated-redis.ts";
import { gatewayEnvironment } from "../../worlds/lib/acme-gateway.ts";
import { bootWorkbot } from "../../worlds/lib/workbot.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Real Den, Den OAuth and Workbot. The owner has two workspaces with Workbot on (Acme, seeded, and Other team) and is
 * signs in through Den's pages in the browser. Only the runner's model is a local fixture.
 */
export async function workbotOpenFromWorkspace(seed: Seed) {
  const resources = new AsyncDisposableStack();
  try {
    const redis = resources.use(await isolatedRedis());
    // Den manages AI Gateway providers; no turn runs through the gateway in this proof, so its process is not started.
    const gateway = await gatewayEnvironment("http://127.0.0.1:9");
    const world = await bootWorkbot(resources, undefined, {
      live: false,
      denEnv: { DATABASE_REDIS_URL: redis.url, DEN_ORG_MODE: "multi_org", ...gateway.env },
    });
    const { den } = world;
    const headers = { authorization: `Bearer ${den.admin.token}` };
    const created = await denFetch(den.admin, "/v1/org", { method: "POST", headers, body: JSON.stringify({ name: "Other team" }) });
    const otherOrganizationId = isRecord(created.body) && isRecord(created.body.organization) ? created.body.organization.id : undefined;
    if (!created.response.ok || typeof otherOrganizationId !== "string") throw new Error(`Could not create the second workspace: HTTP ${created.response.status}`);
    const enabled = await denFetch(den.admin, `/v1/admin/organizations/${otherOrganizationId}/capabilities`, {
      method: "PUT", headers, body: JSON.stringify({ capabilities: { workbot: true } }),
    });
    if (!enabled.response.ok) throw new Error(`Could not turn Workbot on for the second workspace: HTTP ${enabled.response.status}`);
    // Acme has an AI Gateway provider, so its dashboard's Workbot entry opens Workbot instead of asking for one.
    const provider = await denFetch(den.admin, "/v1/inference-providers", {
      method: "POST", headers: { ...headers, "x-openwork-org-id": world.orgId },
      body: JSON.stringify({ name: "Acme AI Gateway", providerId: "anthropic", modelIds: ["claude-sonnet-4-5"], credential: { kind: "api_key", secret: "fixture-key" }, allMembers: true }),
    });
    if (provider.response.status !== 201) throw new Error(`Could not add Acme's AI provider: HTTP ${provider.response.status} ${provider.text.slice(0, 200)}`);
    // Signed out: the owner signs in through Den's own page, so Den's dashboard and Workbot's sign-in share one session.
    const web = await seed.web({ den, headless: true, viewport: { width: 1440, height: 1000 } });
    const denWeb = den.ref.webUrl.replace(/\/+$/, "");
    return {
      web,
      url: world.workbotUrl,
      person: { email: den.admin.email, password: den.admin.password },
      acmeOrganizationId: world.orgId,
      otherOrganizationId,
      /** Den's own link into one workspace's dashboard (the one Workbot's setup links use), which makes it active. */
      dashboardIn: (organizationId: string) => `${denWeb}/dashboard/members?${new URLSearchParams({ workbotOrganizationId: organizationId })}`,
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
