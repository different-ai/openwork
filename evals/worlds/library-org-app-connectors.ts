import { allocateFreePorts, listTargets } from "@openwork/cdp";
import type { AppWeb, Seed } from "@openwork/env";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

/**
 * Library › Add a connector in the app, for an owner and a member of one
 * organization. Den's catalog is served at a proxy so every entry is a fixed,
 * local fixture:
 * - Slack needs the organization's own app (requiresOAuthClient) and is not set up;
 * - Team notes is already added as a per-person sign-in, backed by a local OAuth MCP;
 * - Render signs in with OpenWork's own app (defaultOAuthClientId).
 * No real provider is contacted. Organization setup is generally available.
 */
export async function libraryOrgAppConnectors(seed: Seed) {
  const [memberPort] = await allocateFreePorts(1);
  if (!memberPort) throw new Error("No port available for the member's app.");
  const { den, webPort } = await denForAppWeb(seed, {
    env: { DEN_ALLOW_PRIVATE_MCP_URLS: "1" },
    trustedOrigins: [`http://127.0.0.1:${memberPort}`],
    org: { name: "Acme Studio", admin: { name: "Alex Lee" }, members: { sam: { name: "Sam Taylor" } } },
    mocks: { notes: seed.mock() },
  });
  const notes = den.mocks.notes;
  await seed.orgConnection(den.admin, {
    name: "Team notes", url: notes.mcpUrl, authType: "oauth", credentialMode: "per_member", access: { orgWide: true },
  });

  const presets = [
    {
      presetId: "slack", displayName: "Slack", url: "https://mcp.slack.com/mcp", authType: "oauth", requiresOAuthClient: true,
      description: "Channels, DMs, and search. An admin configures its OAuth client once, then each person connects their own account.",
    },
    { presetId: "notes", displayName: "Team notes", description: "Search the team's meeting notes.", url: notes.mcpUrl, authType: "oauth" },
    {
      presetId: "render", displayName: "Render", url: "https://mcp.render.com/mcp", authType: "oauth", defaultOAuthClientId: "openwork",
      description: "Deploy and manage services, databases, and logs.",
    },
  ];
  const proxy = await seed.faultProxy(den);
  for (const path of ["/api/den/v1/mcp-connections/presets", "/v1/mcp-connections/presets"]) {
    // GET only: the browser's CORS preflight still reaches Den, which answers it.
    await proxy.faults.status(path, 200, { times: 1000, body: { presets }, method: "GET" });
  }
  const shapedDen = { ...den, ref: proxy.ref };
  const viewport = { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false };

  async function open(as: "admin" | "sam") {
    const { app, workspace } = await signedInAppWeb(seed, {
      den: shapedDen, webPort: as === "admin" ? webPort : memberPort, as, name: `library-org-app-${as}`, workspacePath: seed.tmpPath(`library-org-app-${as}`),
    });
    await app.client.send("Emulation.setDeviceMetricsOverride", viewport);
    return { app, libraryUrl: `${app.webUrl}/workspace/${encodeURIComponent(workspace.workspaceId)}/extensions` };
  }

  /** Pages the app opened in a new browser tab (sign-in or OpenWork Cloud). */
  async function openedTabs(app: AppWeb): Promise<string[]> {
    return (await listTargets(app.handle.cdpUrl))
      .filter((entry) => entry.type === "page" && entry.id !== app.client.targetId && entry.url !== "about:blank")
      .map((entry) => entry.url);
  }

  const owner = await open("admin");
  const member = await open("sam");
  return {
    owner, member, openedTabs,
    denWebUrl: den.ref.webUrl,
    notesOrigin: new URL(notes.url).origin,
  };
}
