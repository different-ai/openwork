import { mkdirSync } from "node:fs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "admin-desktop-skill-grants";
const DEN_API_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_WEB_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_WEB_URL);
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const WORKSPACE_PATH = process.env.OPENWORK_EVAL_WORKSPACE_PATH?.trim() || "/tmp/openwork-admin-desktop-skill-grants";
const RUN_TAG = Date.now();
const APPROVED_TITLE = `Approved Admin Playbook ${RUN_TAG}`;
const DEN_ONLY_TITLE = `Den Only Admin Playbook ${RUN_TAG}`;
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const state = {
  adminToken: null,
  organizationId: null,
  memberId: null,
  approvedCapability: null,
  denOnlyCapability: null,
  denManagedTitles: [],
  discoveredTitles: [],
  searchedCapabilityNames: [],
  deniedPayload: null,
};

export default {
  id: FLOW_ID,
  title: "Administrators receive only explicitly granted desktop Skills",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_WORKSPACE_PATH"],
  steps: [
    {
      name: "Den administration remains complete",
      run: async (ctx) => {
        await ctx.prove("The administrator can still manage both Skills in Den", {
          voiceover: vo[0],
          action: async () => {
            await prepareScenario(ctx);
            await signDesktopIntoDen(ctx);
            await ctx.control("settings.panel.open", { panel: "cloud-account" });
            await ctx.waitForText(ADMIN_EMAIL, { timeoutMs: 30_000 });
          },
          assert: async () => {
            witness(
              ctx,
              state.denManagedTitles.includes(APPROVED_TITLE),
              "Den management lists the explicitly approved Skill",
              state.denManagedTitles,
            );
            witness(
              ctx,
              state.denManagedTitles.includes(DEN_ONLY_TITLE),
              "Den management also lists the unassigned Den-only Skill",
              state.denManagedTitles,
            );
            await ctx.expectText(ADMIN_EMAIL);
            await ctx.expectText("OpenWork Cloud");
          },
          screenshot: {
            name: "admin-den-management-context",
            requireText: ["OpenWork Cloud", ADMIN_EMAIL, "Connected"],
            rejectText: ["Something went wrong"],
          },
        });
      },
    },
    {
      name: "Desktop discovery and execution honor grants",
      run: async (ctx) => {
        await ctx.prove("The administrator desktop exposes only the granted Skill and rejects the Den-only Skill", {
          voiceover: vo[1],
          action: async () => {
            await verifyAgentMcpBoundary(ctx);
            await ctx.control("settings.panel.open", { panel: "extensions" });
            await ctx.waitForText("Extensions", { timeoutMs: 30_000 });
            await ctx.clickText("Skills", { selector: "button", timeoutMs: 30_000 });
          },
          assert: async () => {
            witness(
              ctx,
              state.discoveredTitles.includes(APPROVED_TITLE),
              "The live desktop MCP Skill index includes the explicitly granted Skill",
              state.discoveredTitles,
            );
            witness(
              ctx,
              !state.discoveredTitles.includes(DEN_ONLY_TITLE),
              "The live desktop MCP Skill index excludes the unassigned Den-only Skill",
              state.discoveredTitles,
            );
            witness(
              ctx,
              state.searchedCapabilityNames.includes(state.approvedCapability),
              "search_capabilities returns the explicitly granted Skill",
              state.searchedCapabilityNames,
            );
            witness(
              ctx,
              !state.searchedCapabilityNames.includes(state.denOnlyCapability),
              "search_capabilities excludes the unassigned Den-only Skill",
              state.searchedCapabilityNames,
            );
            witness(
              ctx,
              state.deniedPayload?.error === "forbidden",
              "Direct execution of the unassigned Skill is rejected as forbidden",
              state.deniedPayload,
            );
            ctx.output("Desktop Skill grant boundary", JSON.stringify({
              approvedSkill: APPROVED_TITLE,
              denOnlySkill: DEN_ONLY_TITLE,
              discoveredTitles: state.discoveredTitles,
              searchedCapabilityNames: state.searchedCapabilityNames,
              directExecution: state.deniedPayload,
            }, null, 2));
            await ctx.expectText("Extensions");
            await ctx.expectText("Skills");
          },
          screenshot: {
            name: "admin-desktop-cloud-connection",
            requireText: ["Extensions", "Skills"],
            rejectText: ["Something went wrong"],
            hashIncludes: "/settings/extensions",
          },
        });
      },
    },
  ],
};

function cleanBaseUrl(value) {
  return (value ?? "").trim().replace(/\/+$/, "");
}

function witness(ctx, condition, assertion, actual) {
  ctx.recordEvidence({ type: "assertion", status: condition ? "passed" : "failed", assertion, actual });
  ctx.assert(condition, `${assertion}: ${JSON.stringify(actual)}`);
}

async function denFetch(pathname, options = {}) {
  const response = await fetch(`${DEN_API_URL}${pathname}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      origin: DEN_WEB_URL,
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

async function prepareScenario(ctx) {
  const signedIn = await denFetch("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  ctx.assert(
    signedIn.response.ok && typeof signedIn.body?.token === "string",
    `Admin sign-in failed: ${signedIn.response.status} ${signedIn.text.slice(0, 300)}`,
  );
  state.adminToken = signedIn.body.token;

  const orgs = await denFetch("/v1/me/orgs", {
    headers: { authorization: `Bearer ${state.adminToken}` },
  });
  ctx.assert(orgs.response.ok && Array.isArray(orgs.body?.orgs), `Organization lookup failed: ${orgs.text.slice(0, 300)}`);
  const active = orgs.body.orgs.find((org) => org.id === orgs.body.activeOrgId) ?? orgs.body.orgs[0];
  ctx.assert(typeof active?.id === "string", "No active organization resolved for the administrator.");
  state.organizationId = active.id;

  const activated = await denFetch("/v1/me/active-organization", {
    method: "POST",
    headers: { authorization: `Bearer ${state.adminToken}` },
    body: JSON.stringify({ organizationId: state.organizationId }),
  });
  ctx.assert(activated.response.ok, `Active organization update failed: ${activated.text.slice(0, 300)}`);

  await seedSkillPair(ctx);

  const managed = await denFetch(`/v1/plugins?limit=100&q=${encodeURIComponent(`Admin Playbook ${RUN_TAG}`)}`, {
    headers: { authorization: `Bearer ${state.adminToken}` },
  });
  ctx.assert(managed.response.ok && Array.isArray(managed.body?.items), `Den plugin list failed: ${managed.text.slice(0, 300)}`);
  state.denManagedTitles = managed.body.items.flatMap((plugin) =>
    Array.isArray(plugin.configObjects) ? plugin.configObjects.map((item) => item.title) : []
  );
  if (state.denManagedTitles.length === 0) {
    state.denManagedTitles = [APPROVED_TITLE, DEN_ONLY_TITLE].filter((title) => managed.text.includes(title));
  }
}

async function seedSkillPair(ctx) {
  const { createDenDb } = await import("../../ee/packages/den-db/dist/index.js");
  const {
    ConfigObjectAccessGrantTable,
    ConfigObjectTable,
    ConfigObjectVersionTable,
    MarketplacePluginTable,
    MarketplaceTable,
    MemberTable,
    PluginConfigObjectTable,
    PluginTable,
  } = await import("../../ee/packages/den-db/dist/schema.js");
  const { and, eq, isNull } = await import("../../ee/packages/den-db/dist/drizzle.js");
  const { createDenTypeId, normalizeDenTypeId } = await import("../../ee/packages/utils/dist/typeid.js");
  const databaseUrl = process.env.DATABASE_URL;
  ctx.assert(typeof databaseUrl === "string" && databaseUrl.length > 0, "DATABASE_URL is required for the isolated proof seed.");
  const denDb = createDenDb({ databaseUrl, mode: "mysql" });
  const database = denDb.db;
  const organizationId = normalizeDenTypeId("organization", state.organizationId);
  const members = await database
    .select({ id: MemberTable.id, role: MemberTable.role })
    .from(MemberTable)
    .where(and(
      eq(MemberTable.organizationId, organizationId),
      isNull(MemberTable.removedAt),
    ));
  const administrator = members.find((member) => member.role.split(",").some((role) => ["owner", "admin"].includes(role.trim())));
  ctx.assert(Boolean(administrator), "The demo organization has no active owner or administrator membership.");
  state.memberId = administrator.id;

  const seedOne = async (title, granted) => {
    const now = new Date();
    const marketplaceId = createDenTypeId("marketplace");
    const pluginId = createDenTypeId("plugin");
    const configObjectId = createDenTypeId("configObject");
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    await database.insert(MarketplaceTable).values({
      id: marketplaceId,
      organizationId,
      name: `${title} Marketplace`,
      description: "PR #3159 end-to-end proof",
      logoUrl: null,
      status: "active",
      createdByOrgMembershipId: state.memberId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    await database.insert(PluginTable).values({
      id: pluginId,
      organizationId,
      name: `${title} Plugin`,
      description: "PR #3159 end-to-end proof",
      status: "active",
      createdByOrgMembershipId: state.memberId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    await database.insert(ConfigObjectTable).values({
      id: configObjectId,
      organizationId,
      objectType: "skill",
      sourceMode: "cloud",
      title,
      description: `Proof Skill ${title}`,
      searchText: title,
      currentFileName: `${slug}.md`,
      currentFileExtension: ".md",
      currentRelativePath: `skills/${slug}.md`,
      status: "active",
      createdByOrgMembershipId: state.memberId,
      connectorInstanceId: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    });
    await database.insert(MarketplacePluginTable).values({
      id: createDenTypeId("marketplacePlugin"),
      organizationId,
      marketplaceId,
      pluginId,
      membershipSource: "manual",
      createdByOrgMembershipId: state.memberId,
      createdAt: now,
      removedAt: null,
    });
    await database.insert(PluginConfigObjectTable).values({
      id: createDenTypeId("pluginConfigObject"),
      organizationId,
      pluginId,
      configObjectId,
      membershipSource: "manual",
      connectorMappingId: null,
      createdByOrgMembershipId: state.memberId,
      createdAt: now,
      removedAt: null,
    });
    await database.insert(ConfigObjectVersionTable).values({
      id: createDenTypeId("configObjectVersion"),
      organizationId,
      configObjectId,
      normalizedPayloadJson: null,
      rawSourceText: `---\nname: ${slug}\ndescription: ${title}\n---\n\n# ${title}`,
      schemaVersion: null,
      createdVia: "cloud",
      createdByOrgMembershipId: state.memberId,
      connectorSyncEventId: null,
      sourceRevisionRef: null,
      isDeletedVersion: false,
      createdAt: now,
    });
    if (granted) {
      await database.insert(ConfigObjectAccessGrantTable).values({
        id: createDenTypeId("configObjectAccessGrant"),
        organizationId,
        configObjectId,
        orgMembershipId: state.memberId,
        teamId: null,
        orgWide: false,
        role: "viewer",
        createdByOrgMembershipId: state.memberId,
        createdAt: now,
        removedAt: null,
      });
    }
    return `plugin:${pluginId}:${configObjectId}`;
  };

  state.approvedCapability = await seedOne(APPROVED_TITLE, true);
  state.denOnlyCapability = await seedOne(DEN_ONLY_TITLE, false);
  await denDb.client.end();
}

async function signDesktopIntoDen(ctx) {
  mkdirSync(WORKSPACE_PATH, { recursive: true });
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 120_000, label: "desktop control API" });
  await ctx.waitFor("Boolean(window.__OPENWORK_ELECTRON__?.invokeDesktop)", { timeoutMs: 30_000, label: "desktop bridge" });
  const bootstrap = { baseUrl: DEN_WEB_URL, apiBaseUrl: DEN_API_URL, requireSignin: false, handoff: null };
  const configured = await ctx.eval(`(async () => {
    const bridge = window.__OPENWORK_ELECTRON__?.invokeDesktop;
    if (!bridge) return false;
    await bridge("setDesktopBootstrapConfig", ${JSON.stringify(bootstrap)});
    localStorage.setItem("openwork.den.baseUrl", ${JSON.stringify(DEN_WEB_URL)});
    localStorage.setItem("openwork.den.apiBaseUrl", ${JSON.stringify(DEN_API_URL)});
    for (const key of ["openwork.den.authToken", "openwork.den.activeOrgId", "openwork.den.activeOrgSlug", "openwork.den.activeOrgName"]) {
      localStorage.removeItem(key);
    }
    return true;
  })()`, { awaitPromise: true });
  ctx.assert(configured === true, "Desktop bootstrap configuration failed.");
  await ctx.eval("location.reload()");
  await ctx.waitFor("Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "control API after reload" });

  const handoff = await denFetch("/v1/auth/desktop-handoff", {
    method: "POST",
    headers: { authorization: `Bearer ${state.adminToken}` },
    body: JSON.stringify({ desktopScheme: "openwork" }),
  });
  ctx.assert(handoff.response.ok && typeof handoff.body?.grant === "string", `Desktop handoff failed: ${handoff.text.slice(0, 300)}`);
  await ctx.waitFor(
    "window.__openworkControl?.listActions().some((action) => action.id === 'auth.exchange-grant' && !action.disabled)",
    { timeoutMs: 30_000, label: "auth.exchange-grant action" },
  );
  await ctx.control("auth.exchange-grant", { grant: handoff.body.grant, baseUrl: DEN_WEB_URL });
  await ctx.waitFor("Boolean((localStorage.getItem('openwork.den.authToken') ?? '').trim())", {
    timeoutMs: 45_000,
    label: "desktop Den token",
  });

  await ctx.clickText("Continue with organization", { timeoutMs: 5_000 }).catch(() => {});
  await ctx.clickText("Continue to workspace", { timeoutMs: 8_000 }).catch(() => {});
  const folderInput = await ctx.eval("Boolean(document.querySelector('input[placeholder=\"/workspace/my-project\"]'))").catch(() => false);
  if (folderInput) {
    await ctx.fill('input[placeholder="/workspace/my-project"]', WORKSPACE_PATH);
    await ctx.clickText("Use this folder", { timeoutMs: 10_000 });
  }
}

async function mcpCall(ctx, token, method, params = {}) {
  const response = await fetch(`${DEN_API_URL}/mcp/agent`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const raw = await response.text();
  ctx.assert(response.ok, `MCP ${method} failed: ${response.status} ${raw.slice(0, 300)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  ctx.assert(Boolean(dataLine), `MCP ${method} returned no data frame: ${raw.slice(0, 300)}`);
  const payload = JSON.parse(dataLine.slice(5));
  ctx.assert(!payload.error, `MCP ${method} returned ${JSON.stringify(payload.error)}`);
  return payload.result;
}

async function verifyAgentMcpBoundary(ctx) {
  const minted = await denFetch("/v1/mcp/token", {
    method: "POST",
    headers: { authorization: `Bearer ${state.adminToken}` },
    body: JSON.stringify({}),
  });
  ctx.assert(minted.response.ok && typeof minted.body?.token === "string", `MCP token mint failed: ${minted.text.slice(0, 300)}`);

  const resources = await mcpCall(ctx, minted.body.token, "resources/list");
  state.discoveredTitles = (resources.resources ?? []).map((resource) => resource.title).filter(Boolean);

  const searched = await mcpCall(ctx, minted.body.token, "tools/call", {
    name: "search_capabilities",
    arguments: { query: `Admin Playbook ${RUN_TAG}`, type: "skills", limit: 20 },
  });
  const searchedText = searched.content?.[0]?.text ?? "{}";
  let searchedPayload;
  try {
    searchedPayload = JSON.parse(searchedText);
  } catch {
    searchedPayload = { raw: searchedText };
  }
  ctx.assert(Array.isArray(searchedPayload?.matches), `Unexpected search_capabilities payload: ${searchedText.slice(0, 300)}`);
  state.searchedCapabilityNames = searchedPayload.matches.map((match) => match.name).filter(Boolean);

  const denied = await mcpCall(ctx, minted.body.token, "tools/call", {
    name: "execute_capability",
    arguments: { name: state.denOnlyCapability },
  });
  const deniedText = denied.content?.[0]?.text ?? "{}";
  try {
    state.deniedPayload = JSON.parse(deniedText);
  } catch {
    state.deniedPayload = { raw: deniedText };
  }
}
