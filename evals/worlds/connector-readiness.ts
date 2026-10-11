import type { Seed, Place } from "@openwork/env";
import { faultProxy } from "@openwork/env";
import { enableOrganizationCapabilities } from "./dashboards.ts";
import { isRecord, records } from "./library.ts";
import { engineBinary } from "./openwork-server-cli.ts";

export async function connectorReadiness(seed: Seed, ctx: { place: Place }) {
  const den = await seed.den({
    org: { name: `Connector checks ${Date.now()}`, members: { teammate: { name: "Sam Member" } } },
    mocks: { notes: seed.mock({ allowUnauthenticatedMcp: true, tools: [{ name: "read_notes", description: "Read team notes", inputSchema: { type: "object" }, result: { content: [{ type: "text", text: "Notes." }] } }] }) },
  });
  const upstream = await faultProxy({ apiUrl: den.mocks.notes.url, webUrl: den.mocks.notes.url }, { place: ctx.place });
  const created = await seed.api(den.admin, "/v1/mcp-connections", {
    method: "POST", body: JSON.stringify({ name: "Team Notes", url: `${upstream.ref.webUrl}/mcp`, authType: "none", credentialMode: "shared", access: { orgWide: true } }),
  });
  if (!created.response.ok || !isRecord(created.body) || typeof created.body.id !== "string") throw new Error(`Could not create test connection: ${created.response.status} ${created.text}`);
  const id = created.body.id;
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/mcp-connections", headless: true, viewport: { width: 1280, height: 900 } });
  const memberWeb = await seed.web({ den, signedInAs: den.members.teammate, startPath: "/dashboard/your-connections", headless: true, viewport: { width: 1280, height: 900 } });
  const binary = engineBinary();
  if (!binary) throw new Error("Prepare the shipped OpenCode sidecar before running this world.");
  const app = await seed.appWeb({ name: "connector-readiness", workspacePath: seed.tmpPath("connector-readiness"), engine: "v2", headless: true, env: {
    OPENWORK_OPENCODE_BIN: binary,
    OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1", OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
    OPENWORK_DEV_HEADLESS_DEN_API_TARGET: den.ref.apiUrl,
    VITE_DEN_BASE_URL: den.ref.webUrl, VITE_DEN_API_BASE_URL: "/api/den",
  } });
  await seed.signIn(app, den.admin, "Connection admin");
  return {
    den, web, memberWeb, app, id, upstream,
    async enable() { await enableOrganizationCapabilities(seed, den.admin, { connectorReadiness: true }); },
    async breakServer() { await upstream.faults.status("/mcp", 503, { times: 10000 }); },
    async fixServer() { await upstream.faults.clear(); },
    async refuseMemberCheck() { return seed.api(den.members.teammate, `/v1/mcp-connections/${id}/check`, { method: "POST" }); },
    async disable() {
      const context = await seed.api(den.admin, "/v1/org");
      const org = isRecord(context.body) && isRecord(context.body.organization) ? context.body.organization.id : null;
      if (typeof org !== "string") throw new Error("Missing test organization.");
      const result = await seed.api(den.admin, `/v1/admin/organizations/${org}/capabilities`, { method: "PUT", body: JSON.stringify({ capabilities: { connectorReadiness: false } }) });
      if (!result.response.ok) throw new Error("Could not disable readiness.");
    },
    async saved(name = "Team Notes") {
      const response = await seed.api(den.admin, "/v1/mcp-connections?scope=manageable");
      return isRecord(response.body) ? records(response.body.connections).find((row) => row.name === name) : undefined;
    },
  };
}
