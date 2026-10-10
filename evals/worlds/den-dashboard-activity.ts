import { createOrg, type Seed } from "@openwork/env";
import type { DenSession } from "@openwork/behaviors";
import { activityTransportFaults } from "./den-dashboard-activity-faults.ts";
import { enableOrganizationCapabilities } from "./dashboards.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected a Den collection.");
  return value.filter(isRecord);
}

function field(value: unknown, key: string): string {
  const result = isRecord(value) ? value[key] : undefined;
  if (typeof result !== "string" || !result) throw new Error(`Activity arrangement is missing ${key}.`);
  return result;
}

/**
 * Real Den, two opted-in workspaces, one default-off workspace, and a member.
 * Only the external MCP server is synthetic; all additions and skill versions
 * are persisted by Den. Nothing writes Activity's responses or browser cache.
 */
export async function denDashboardActivity(seed: Seed) {
  return activityWorkspace(seed, false);
}

export async function denDashboardActivityLoading(seed: Seed) {
  return activityWorkspace(seed, true);
}

async function activityWorkspace(seed: Seed, populated: boolean) {
  const stamp = Date.now();
  const names = {
    workspace: `Activity workspace ${stamp}`,
    otherWorkspace: `Activity archive ${stamp}`,
    disabledWorkspace: `Activity rollout off ${stamp}`,
    connection: "Team reference notes",
    plugin: "Activity handbook",
    skill: "activity-briefing",
  };
  const den = await seed.den({
    env: { DEN_ORG_MODE: "multi_org" },
    org: {
      name: names.workspace,
      admin: { name: "Activity Owner" },
      members: { member: { name: "Activity Member" } },
    },
    mocks: { connector: seed.mock({ allowUnauthenticatedMcp: true }) },
  });
  const initial = await seed.api(den.admin, "/v1/org");
  if (!initial.response.ok || !isRecord(initial.body)) throw new Error("Could not read the initial workspace.");
  const orgId = field(initial.body.organization, "id");
  const otherOrg = await createOrg(den, names.otherWorkspace);
  const otherOrgId = otherOrg.id;
  await enableOrganizationCapabilities(seed, den.admin, { dashboardActivity: true }, orgId);
  await enableOrganizationCapabilities(seed, den.admin, { dashboardActivity: true }, otherOrgId);
  const disabledOrg = await createOrg(den, names.disabledWorkspace);
  const disabledConnection = await seed.api(den.admin, "/v1/mcp-connections", {
    method: "POST", headers: { "x-openwork-org-id": disabledOrg.id },
    body: JSON.stringify({ name: "Retained connection", url: den.mocks.connector.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true } }),
  });
  if (!disabledConnection.response.ok) throw new Error("Could not arrange the default-off workspace's connection.");
  const disabledConnectionId = field(disabledConnection.body, "id");
  const otherHeaders = { "x-openwork-org-id": otherOrgId };
  const otherApi = async (path: string, init: RequestInit = {}) => {
    const result = await seed.api(den.admin, path, { ...init, headers: otherHeaders });
    if (!result.response.ok) throw new Error(`Activity arrangement ${path}: HTTP ${result.response.status}: ${result.text.slice(0, 300)}`);
    return result.body;
  };

  // Finish the ordinary built-in catalog setup before our dated additions.
  // Do not delete or conceal system defaults to manufacture an empty screen.
  await otherApi("/v1/marketplaces");
  const additions: { id: string; name: string }[] = [];
  for (let index = 1; index <= 7; index += 1) {
    const name = `Archive connector ${index}`;
    const body = await otherApi("/v1/mcp-connections", {
      method: "POST",
      body: JSON.stringify({
        name, url: den.mocks.connector.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true },
      }),
    });
    additions.push({ id: field(body, "id"), name });
  }
  const plugin = await otherApi("/v1/plugins", {
    method: "POST",
    body: JSON.stringify({
      name: names.plugin, orgWide: true,
      components: [{ type: "skill", input: {
        rawSourceText: `---\nname: ${names.skill}\ndescription: Summarize supplied notes.\n---\n\nSummarize the supplied notes.`,
        metadata: { name: names.skill, description: "Summarize supplied notes." },
      } }],
    }),
  });
  const pluginId = field(isRecord(plugin) ? plugin.item : undefined, "id");
  const resolved = await otherApi(`/v1/plugins/${pluginId}/resolved`);
  const skill = records(isRecord(resolved) ? resolved.items : undefined)
    .map((entry) => entry.configObject).filter(isRecord).find((entry) => entry.objectType === "skill");
  const skillId = field(skill, "id");
  const skillTitle = field(skill, "title");
  await otherApi(`/v1/config-objects/${skillId}/versions`, {
    method: "POST",
    body: JSON.stringify({
      input: {
        rawSourceText: `---\nname: ${names.skill}\ndescription: Summarize supplied notes.\n---\n\nSummarize the supplied notes and next steps.`,
        metadata: { name: names.skill, description: "Summarize supplied notes." },
      },
      reason: "Include next steps in the briefing",
    }),
  });

  const performanceEvents: { id: string; title: string; createdAt: string; href: string }[] = [];
  if (populated) {
    for (let p = 0; p < 12; p++) {
      const created = await otherApi("/v1/plugins", {
        method: "POST",
        body: JSON.stringify({
          name: `Reference handbook ${p}`, orgWide: true,
          components: Array.from({ length: 8 }, (_, s) => ({ type: "skill", input: {
            rawSourceText: `---\nname: reference-${p}-${s}\ndescription: Summarize supplied notes.\n---\n\nSummarize the supplied notes.`,
            metadata: { name: `reference-${p}-${s}`, description: "Summarize supplied notes." },
          } })),
        }),
      });
      const id = field(isRecord(created) ? created.item : undefined, "id");
      const contents = await otherApi(`/v1/plugins/${id}/resolved`);
      const skills = records(isRecord(contents) ? contents.items : undefined).map((entry) => entry.configObject).filter(isRecord);
      for (const skill of skills) {
        performanceEvents.push({
          id: `skill:${field(skill.latestVersion, "id")}`,
          title: `A new version of ${field(skill, "title")} was published`,
          createdAt: field(skill.latestVersion, "createdAt"),
          href: `/dashboard/plugins/${id}/skills/${field(skill, "id")}`,
        });
      }
    }
    if (performanceEvents.length !== 96) throw new Error("Performance fixture must persist 96 dated skills.");
    performanceEvents.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  }

  const activityPath = "/api/browser/v1/mcp-connections?scope=manageable";
  const viewport = { width: 1440, height: 900 };
  async function signedInBrowser(person: DenSession, startPath: string) {
    const browser = await seed.web({ den, startPath: "/", headless: true, viewport });
    // Workspace switching uses Better Auth's cookie session, not the desktop
    // bearer stored by seed.web({ signedInAs }). Seed a real password sign-in.
    const signedIn = await seed.api(person, "/api/auth/sign-in/email", {
      method: "POST", headers: { origin: den.ref.webUrl },
      body: JSON.stringify({ email: person.email, password: person.password }),
    });
    const cookie = signedIn.response.headers.getSetCookie().find((value) => value.includes("session_token="))?.split(";")[0] ?? "";
    const separator = cookie.indexOf("=");
    if (!signedIn.response.ok || separator < 1) throw new Error(`Activity browser sign-in failed: HTTP ${signedIn.response.status}`);
    const applied = await browser.client.send("Network.setCookie", {
      name: cookie.slice(0, separator), value: cookie.slice(separator + 1),
      url: den.ref.webUrl, path: "/", httpOnly: true, secure: new URL(den.ref.webUrl).protocol === "https:",
    });
    if (!isRecord(applied) || applied.success !== true) throw new Error("Could not install the server-issued browser session cookie.");
    const selected = await seed.api(person, "/api/auth/organization/set-active", {
      method: "POST", headers: { cookie, origin: den.ref.webUrl }, body: JSON.stringify({ organizationId: orgId }),
    });
    if (!selected.response.ok) throw new Error(`Activity workspace selection failed: HTTP ${selected.response.status}`);
    await browser.client.send("Page.navigate", { url: new URL(startPath, den.ref.webUrl).toString() });
    return browser;
  }
  const memberWeb = await signedInBrowser(den.members.member, "/dashboard");
  const web = await signedInBrowser(den.admin, "/dashboard/members");
  // Keep the canonical origin (and its real cookie/CSRF checks) unchanged.
  // Only this read's response can be delayed or replaced with a failure.
  const faults = await activityTransportFaults(web, new URL(den.ref.webUrl).origin, activityPath);
  return {
    den, web, memberWeb, names, orgId, otherOrgId, additions, pluginId, skillId, skillTitle,
    disabledOrgId: disabledOrg.id, disabledConnectionId, performanceEvents: performanceEvents.slice(0, 5),
    baseUrl: den.ref.webUrl,
    async [Symbol.asyncDispose]() {
      try { await faults[Symbol.asyncDispose](); }
      finally {
        // Both handles use the same owner. Do not overlap their session/org
        // deletion flows, particularly with the populated performance fixture.
        try { await otherOrg[Symbol.asyncDispose](); }
        finally { await disabledOrg[Symbol.asyncDispose](); }
      }
    },
    connector: den.mocks.connector,
    activityPath,
    faults,
  };
}
