import { denFetch } from "@openwork/behaviors";
import type { Seed } from "@openwork/env";
import { isolatedRedis } from "./isolated-redis.ts";
import { bootWorkbot } from "../../worlds/lib/workbot.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Real Den, Den OAuth and Workbot. The owner has two workspaces with Workbot on (Acme, seeded, and Other team) and is
 * signed in to Den in the browser. Only the runner's model is a local fixture.
 */
export async function workbotOpenFromWorkspace(seed: Seed) {
  const resources = new AsyncDisposableStack();
  try {
    const redis = resources.use(await isolatedRedis());
    const world = await bootWorkbot(resources, undefined, {
      live: false,
      denEnv: { DATABASE_REDIS_URL: redis.url, DEN_ORG_MODE: "multi_org" },
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
    // The browser's Den session starts in Acme, as when the owner last used Workbot there.
    const active = await denFetch(den.admin, "/v1/me/active-organization", { method: "POST", headers, body: JSON.stringify({ organizationId: world.orgId }) });
    if (!active.response.ok) throw new Error(`Could not start in Acme: HTTP ${active.response.status}`);
    const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard", headless: true, viewport: { width: 1440, height: 1000 } });
    const denWeb = den.ref.webUrl.replace(/\/+$/, "");
    return {
      web,
      url: world.workbotUrl,
      acmeOrganizationId: world.orgId,
      otherOrganizationId,
      /** Den's own link into one workspace's dashboard (the one Workbot's setup links use), which makes it active. */
      dashboardIn: (organizationId: string) => `${denWeb}/dashboard/members?${new URLSearchParams({ workbotOrganizationId: organizationId })}`,
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
