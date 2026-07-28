import { mkdirSync } from "node:fs";
import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const FLOW_ID = "admin-desktop-skill-grants";
const DEN_API_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_API_URL);
const DEN_WEB_URL = cleanBaseUrl(process.env.OPENWORK_EVAL_DEN_WEB_URL);
const ADMIN_EMAIL = process.env.OPENWORK_EVAL_DEMO_EMAIL?.trim() || "alex@acme.test";
const ADMIN_PASSWORD = process.env.OPENWORK_EVAL_DEMO_PASSWORD?.trim() || "OpenWorkDemo123!";
const WORKSPACE_PATH = process.env.OPENWORK_EVAL_WORKSPACE_PATH?.trim() || "/tmp/openwork-admin-desktop-skill-grants";
const RUN_TAG = Date.now();
const APPROVED_TITLE = `Admin Access Approved Skill ${RUN_TAG}`;
const DEN_ONLY_TITLE = `Admin Access Den Only Skill ${RUN_TAG}`;
const PLUGIN_GRANTED_TITLE = `Admin Access Plugin Granted Command ${RUN_TAG}`;
const PLUGIN_DEN_ONLY_TITLE = `Admin Access Den Only Command ${RUN_TAG}`;
const MCP_GRANTED_TITLE = `Admin Access Marketplace Granted MCP ${RUN_TAG}`;
const MCP_DEN_ONLY_TITLE = `Admin Access Den Only MCP ${RUN_TAG}`;
const ALL_MANAGED_TITLES = [
  APPROVED_TITLE,
  DEN_ONLY_TITLE,
  PLUGIN_GRANTED_TITLE,
  PLUGIN_DEN_ONLY_TITLE,
  MCP_GRANTED_TITLE,
  MCP_DEN_ONLY_TITLE,
];
const vo = await loadVoiceoverParagraphs(FLOW_ID);

const state = {
  adminToken: null,
  organizationId: null,
  memberId: null,
  approvedCapability: null,
  denOnlyCapability: null,
  pluginGrantedCapability: null,
  pluginDenOnlyCapability: null,
  mcpGrantedCapability: null,
  mcpDenOnlyCapability: null,
  denManagedTitles: [],
  assignedConfigObjectIds: [],
  discoveredTitles: [],
  searchedCapabilityNames: [],
  allowedPayloads: {},
  deniedPayloads: {},
};

export default {
  id: FLOW_ID,
  title: "Administrators receive only explicitly granted desktop Connect capabilities",
  kind: "user-facing",
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL", "OPENWORK_EVAL_WORKSPACE_PATH"],
  steps: [
    {
      name: "Den administration remains complete",
      run: async (ctx) => {
        await ctx.prove("The administrator can still manage every Skill, plugin capability, and MCP declaration in Den", {
          voiceover: vo[0],
          action: async () => {
            await prepareScenario(ctx);
            await signDesktopIntoDen(ctx);
            await ctx.control("settings.panel.open", { panel: "cloud-account" });
            await ctx.waitForText(ADMIN_EMAIL, { timeoutMs: 30_000 });
          },
          assert: async () => {
            for (const title of ALL_MANAGED_TITLES) {
              witness(
                ctx,
                state.denManagedTitles.includes(title),
                `Den management lists ${title}`,
                state.denManagedTitles,
              );
            }
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
        await ctx.prove("The administrator agent can discover, search, and execute only granted Skills, plugin capabilities, and MCP declarations", {
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
            for (const [label, capability] of [
              ["Skill", state.approvedCapability],
              ["plugin-granted command", state.pluginGrantedCapability],
              ["marketplace-granted MCP declaration", state.mcpGrantedCapability],
            ]) {
              witness(
                ctx,
                state.assignedConfigObjectIds.includes(capabilityConfigObjectId(capability)),
                `The desktop inventory endpoint returns the granted ${label}`,
                state.assignedConfigObjectIds,
              );
            }
            for (const [label, capability] of [
              ["Skill", state.denOnlyCapability],
              ["command", state.pluginDenOnlyCapability],
              ["MCP declaration", state.mcpDenOnlyCapability],
            ]) {
              witness(
                ctx,
                !state.assignedConfigObjectIds.includes(capabilityConfigObjectId(capability)),
                `The desktop inventory endpoint excludes the unassigned ${label}`,
                state.assignedConfigObjectIds,
              );
            }
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
            for (const [label, capability] of [
              ["plugin-granted command", state.pluginGrantedCapability],
              ["marketplace-granted MCP declaration", state.mcpGrantedCapability],
            ]) {
              witness(
                ctx,
                state.searchedCapabilityNames.includes(capability),
                `search_capabilities returns the ${label}`,
                state.searchedCapabilityNames,
              );
            }
            for (const [label, capability] of [
              ["unassigned command", state.pluginDenOnlyCapability],
              ["unassigned MCP declaration", state.mcpDenOnlyCapability],
            ]) {
              witness(
                ctx,
                !state.searchedCapabilityNames.includes(capability),
                `search_capabilities excludes the ${label}`,
                state.searchedCapabilityNames,
              );
            }
            for (const [label, payload] of Object.entries(state.allowedPayloads)) {
              witness(ctx, payload?.error === undefined, `Direct execution allows the granted ${label}`, payload);
            }
            for (const [label, payload] of Object.entries(state.deniedPayloads)) {
              witness(ctx, payload?.error === "forbidden", `Direct execution rejects the unassigned ${label}`, payload);
            }
            ctx.output("Admin capability grant boundary", JSON.stringify({
              approvedSkill: APPROVED_TITLE,
              denOnlySkill: DEN_ONLY_TITLE,
              pluginGrantedCommand: PLUGIN_GRANTED_TITLE,
              denOnlyCommand: PLUGIN_DEN_ONLY_TITLE,
              marketplaceGrantedMcp: MCP_GRANTED_TITLE,
              denOnlyMcp: MCP_DEN_ONLY_TITLE,
              discoveredTitles: state.discoveredTitles,
              searchedCapabilityNames: state.searchedCapabilityNames,
              allowedExecution: state.allowedPayloads,
              deniedExecution: state.deniedPayloads,
            }, null, 2));
            await ctx.expectText("Extensions");
            await ctx.expectText("Skills");
            await ctx.expectText(APPROVED_TITLE);
            await ctx.expectNoText(DEN_ONLY_TITLE);
          },
          screenshot: {
            name: "admin-desktop-cloud-connection",
            requireText: ["Extensions", "Skills", APPROVED_TITLE],
            rejectText: ["Something went wrong", DEN_ONLY_TITLE],
            hashIncludes: "/settings/extensions",
          },
        });
      },
    },
    {
      name: "Desktop MCP connection context honors grants",
      run: async (ctx) => {
        await ctx.prove("The administrator desktop shows the granted MCP declaration without exposing the unassigned MCP", {
          voiceover: vo[2],
          action: async () => {
            await ctx.control("settings.panel.open", { panel: "extensions" });
            await ctx.waitForText("Extensions", { timeoutMs: 30_000 });
            await ctx.clickText("Connections", { selector: "button", timeoutMs: 30_000 });
            await ctx.waitForText(MCP_GRANTED_TITLE, { timeoutMs: 30_000 });
          },
          assert: async () => {
            await ctx.expectText(MCP_GRANTED_TITLE);
            await ctx.expectNoText(MCP_DEN_ONLY_TITLE);
          },
          screenshot: {
            name: "admin-desktop-assigned-mcp-context",
            requireText: ["Extensions", "Connections", MCP_GRANTED_TITLE],
            rejectText: ["Something went wrong", MCP_DEN_ONLY_TITLE],
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

function capabilityConfigObjectId(capability) {
  return capability?.split(":")[2] ?? "";
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

  await seedCapabilityMatrix(ctx);

  const managed = await denFetch(`/v1/plugins?limit=100&q=${encodeURIComponent(String(RUN_TAG))}`, {
    headers: { authorization: `Bearer ${state.adminToken}` },
  });
  ctx.assert(managed.response.ok && Array.isArray(managed.body?.items), `Den plugin list failed: ${managed.text.slice(0, 300)}`);
  state.denManagedTitles = managed.body.items.flatMap((plugin) =>
    Array.isArray(plugin.configObjects) ? plugin.configObjects.map((item) => item.title) : []
  );
  if (state.denManagedTitles.length === 0) {
    state.denManagedTitles = ALL_MANAGED_TITLES.filter((title) => managed.text.includes(title));
  }
}

async function seedCapabilityMatrix(ctx) {
  const { createDenDb } = await import("../../ee/packages/den-db/dist/index.js");
  const {
    ConfigObjectAccessGrantTable,
    ConfigObjectTable,
    ConfigObjectVersionTable,
    MarketplaceAccessGrantTable,
    MarketplacePluginTable,
    MarketplaceTable,
    MemberTable,
    PluginAccessGrantTable,
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

  const seedOne = async ({ grant, objectType, title }) => {
    const now = new Date();
    const marketplaceId = createDenTypeId("marketplace");
    const pluginId = createDenTypeId("plugin");
    const configObjectId = createDenTypeId("configObject");
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const isMcp = objectType === "mcp";
    const normalizedPayloadJson = isMcp
      ? { mcpServers: { proof: { url: `https://${slug}.example.test/remote` } } }
      : null;
    const rawSourceText = isMcp
      ? JSON.stringify(normalizedPayloadJson)
      : objectType === "command"
        ? `Run ${title}.`
        : `---\nname: ${slug}\ndescription: ${title}\n---\n\n# ${title}`;
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
      objectType,
      sourceMode: "cloud",
      title,
      description: `Proof ${objectType} ${title}`,
      searchText: title,
      currentFileName: `${slug}${isMcp ? ".json" : ".md"}`,
      currentFileExtension: isMcp ? ".json" : ".md",
      currentRelativePath: `${objectType}s/${slug}${objectType === "skill" ? "/SKILL.md" : isMcp ? ".json" : ".md"}`,
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
      normalizedPayloadJson,
      rawSourceText,
      schemaVersion: null,
      createdVia: "cloud",
      createdByOrgMembershipId: state.memberId,
      connectorSyncEventId: null,
      sourceRevisionRef: null,
      isDeletedVersion: false,
      createdAt: now,
    });
    if (grant === "config_object") {
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
    if (grant === "plugin") {
      await database.insert(PluginAccessGrantTable).values({
        id: createDenTypeId("pluginAccessGrant"),
        organizationId,
        pluginId,
        orgMembershipId: state.memberId,
        teamId: null,
        orgWide: false,
        role: "viewer",
        createdByOrgMembershipId: state.memberId,
        createdAt: now,
        removedAt: null,
      });
    }
    if (grant === "marketplace") {
      await database.insert(MarketplaceAccessGrantTable).values({
        id: createDenTypeId("marketplaceAccessGrant"),
        organizationId,
        marketplaceId,
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

  state.approvedCapability = await seedOne({ grant: "config_object", objectType: "skill", title: APPROVED_TITLE });
  state.denOnlyCapability = await seedOne({ grant: "none", objectType: "skill", title: DEN_ONLY_TITLE });
  state.pluginGrantedCapability = await seedOne({ grant: "plugin", objectType: "command", title: PLUGIN_GRANTED_TITLE });
  state.pluginDenOnlyCapability = await seedOne({ grant: "none", objectType: "command", title: PLUGIN_DEN_ONLY_TITLE });
  state.mcpGrantedCapability = await seedOne({ grant: "marketplace", objectType: "mcp", title: MCP_GRANTED_TITLE });
  state.mcpDenOnlyCapability = await seedOne({ grant: "none", objectType: "mcp", title: MCP_DEN_ONLY_TITLE });
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

  const selectedWorkspace = await ctx.eval(
    "Boolean((localStorage.getItem('openwork.react.activeWorkspace') ?? '').trim())",
  );
  if (!selectedWorkspace) {
    await ctx.waitFor(
      "window.__openworkControl?.listActions().some((action) => action.id === 'workspace.create' && !action.disabled)",
      { timeoutMs: 60_000, label: "workspace.create action" },
    );
    await ctx.control("workspace.create", { path: WORKSPACE_PATH });
    await ctx.waitFor(
      "Boolean((localStorage.getItem('openwork.react.activeWorkspace') ?? '').trim())",
      { timeoutMs: 60_000, label: "selected eval workspace" },
    );
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

  const assigned = await denFetch("/v1/resources/marketplace-capabilities", {
    headers: { authorization: `Bearer ${state.adminToken}` },
  });
  ctx.assert(
    assigned.response.ok && Array.isArray(assigned.body?.items),
    `Assigned desktop capability inventory failed: ${assigned.response.status} ${assigned.text.slice(0, 300)}`,
  );
  state.assignedConfigObjectIds = assigned.body.items.map((item) => item.configObjectId).filter(Boolean);

  const searched = await mcpCall(ctx, minted.body.token, "tools/call", {
    name: "search_capabilities",
    arguments: { query: `Admin Access ${RUN_TAG}`, type: "marketplace", limit: 20 },
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

  const execute = async (name) => {
    const result = await mcpCall(ctx, minted.body.token, "tools/call", {
      name: "execute_capability",
      arguments: { name },
    });
    const text = result.content?.[0]?.text ?? "{}";
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  };
  for (const [label, capability] of [
    ["Skill", state.approvedCapability],
    ["plugin-granted command", state.pluginGrantedCapability],
    ["marketplace-granted MCP declaration", state.mcpGrantedCapability],
  ]) {
    state.allowedPayloads[label] = await execute(capability);
  }
  for (const [label, capability] of [
    ["Skill", state.denOnlyCapability],
    ["command", state.pluginDenOnlyCapability],
    ["MCP declaration", state.mcpDenOnlyCapability],
  ]) {
    state.deniedPayloads[label] = await execute(capability);
  }
}
