import { loadVoiceoverParagraphs } from "../runner/voiceover.mjs";

const vo = await loadVoiceoverParagraphs("marketplace-core-extension-surface");

const GITHUB_PLUGIN_URL = "https://github.com/anthropics/knowledge-work-plugins/tree/main/sales";
const DIRECTORY_MARKETPLACE_NAME = "OpenWork Directory";
const DIRECTORY_PLUGIN_NAME = "Context7";
const API_KEY_DIRECTORY_PLUGIN_NAME = "Exa";
const SENTINEL_SERVER_KEY = "fraimz-skip-all-mcp-servers";

const state = {
  context7ConnectionId: "",
  context7PluginId: "",
  context7ServerKey: "",
  exaConnectionId: "",
  exaConfigObjectId: "",
  exaPluginId: "",
  exaServerKey: "",
  importedConfigObjectId: "",
  importedPluginId: "",
  importedSkillId: "",
  importedSkillName: "",
  marketplaceId: "",
  mcpToken: "",
  orgId: "",
};

function apiBase(ctx) {
  return ctx.env.OPENWORK_EVAL_DEN_API_URL.trim().replace(/\/+$/, "");
}

async function apiFetch(ctx, path, options = {}) {
  const response = await fetch(`${apiBase(ctx)}${path}`, {
    ...options,
    headers: {
      authorization: `Bearer ${ctx.env.OPENWORK_EVAL_DEN_TOKEN.trim()}`,
      "content-type": "application/json",
      origin: apiBase(ctx),
      ...(state.orgId ? { "x-openwork-org-id": state.orgId } : {}),
      ...(options.headers ?? {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { body, response };
}

async function apiJson(ctx, path, options = {}) {
  const { body, response } = await apiFetch(ctx, path, options);
  ctx.assert(response.ok, `${options.method ?? "GET"} ${path} failed: ${response.status} ${JSON.stringify(body).slice(0, 500)}`);
  return body;
}

async function mcpAgentCall(ctx, method, params) {
  const response = await fetch(`${apiBase(ctx)}/mcp/agent`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${state.mcpToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const raw = await response.text();
  ctx.assert(response.ok, `MCP ${method} failed: ${response.status} ${raw.slice(0, 300)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  ctx.assert(Boolean(dataLine), `MCP ${method} returned no data frame: ${raw.slice(0, 300)}`);
  const payload = JSON.parse(dataLine.slice(5));
  ctx.assert(!payload.error, `MCP ${method} returned JSON-RPC error: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

function toolText(result) {
  return result?.content?.[0]?.text ?? "";
}

function parseToolJson(result) {
  const text = toolText(result);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export default {
  id: "marketplace-core-extension-surface",
  title: "Marketplace becomes the core extension surface for MCP templates and imported skills",
  kind: "internal",
  requiresApp: false,
  requiredEnv: ["OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_TOKEN"],
  steps: [
    {
      name: "Directory marketplace exposes pure MCP templates",
      run: async (ctx) => {
        await ctx.prove("OpenWork Directory is present and exposes Context7 as a plugin MCP template", {
          voiceover: vo[0],
          assert: async () => {
            if (!state.orgId) {
              const orgs = await apiJson(ctx, "/v1/me/orgs");
              const ownerOrg = (orgs.orgs ?? []).find((org) =>
                String(org.role ?? "").split(",").map((role) => role.trim()).some((role) => role === "owner" || role === "admin"));
              ctx.assert(Boolean(ownerOrg), `No owner/admin org available for plugin import proof: ${JSON.stringify(orgs.orgs ?? [])}`);
              state.orgId = ownerOrg.id;
            }
            const scopedMarketplaces = await apiJson(ctx, "/v1/marketplaces");
            const directory = (scopedMarketplaces.items ?? []).find((entry) => entry.name === DIRECTORY_MARKETPLACE_NAME);
            ctx.assert(Boolean(directory), `Missing ${DIRECTORY_MARKETPLACE_NAME}: ${JSON.stringify(scopedMarketplaces.items ?? [])}`);
            state.marketplaceId = directory.id;

            const resolved = await apiJson(ctx, `/v1/marketplaces/${encodeURIComponent(state.marketplaceId)}/resolved`);
            const plugins = resolved.item?.plugins ?? [];
            const context7 = plugins.find((plugin) => plugin.name === DIRECTORY_PLUGIN_NAME);
            ctx.assert(Boolean(context7), `Missing ${DIRECTORY_PLUGIN_NAME} plugin in directory: ${plugins.map((plugin) => plugin.name).join(", ")}`);
            state.context7PluginId = context7.id;
            const exa = plugins.find((plugin) => plugin.name === API_KEY_DIRECTORY_PLUGIN_NAME);
            ctx.assert(Boolean(exa), `Missing ${API_KEY_DIRECTORY_PLUGIN_NAME} plugin in directory: ${plugins.map((plugin) => plugin.name).join(", ")}`);
            state.exaPluginId = exa.id;

            const templates = await apiJson(ctx, `/v1/plugins/${encodeURIComponent(state.context7PluginId)}/server-templates`);
            const template = (templates.item?.mcpTemplates ?? []).find((entry) =>
              entry.name?.toLowerCase() === DIRECTORY_PLUGIN_NAME.toLowerCase() ||
              entry.serverKey === "context7");
            ctx.assert(Boolean(template), `Missing Context7 MCP template: ${JSON.stringify(templates.item?.mcpTemplates ?? [])}`);
            ctx.assert(template.url === "https://mcp.context7.com/mcp", `Unexpected Context7 URL: ${template.url}`);
            ctx.assert(template.authType === "none", `Context7 should be no-auth, got ${template.authType}`);
            state.context7ServerKey = template.serverKey;

            const exaTemplates = await apiJson(ctx, `/v1/plugins/${encodeURIComponent(state.exaPluginId)}/server-templates`);
            const exaTemplate = (exaTemplates.item?.mcpTemplates ?? []).find((entry) =>
              entry.name?.toLowerCase() === API_KEY_DIRECTORY_PLUGIN_NAME.toLowerCase() ||
              entry.serverKey === "exa");
            ctx.assert(Boolean(exaTemplate), `Missing Exa MCP template: ${JSON.stringify(exaTemplates.item?.mcpTemplates ?? [])}`);
            ctx.assert(exaTemplate.authType === "apikey", `Exa should require an API key, got ${exaTemplate.authType}`);
            const apiKeyField = (exaTemplate.configFields ?? []).find((field) => field.key === "api_key" && field.placement === "bearer");
            ctx.assert(Boolean(apiKeyField), `Exa template should expose a bearer API key field: ${JSON.stringify(exaTemplate.configFields ?? [])}`);
            state.exaConfigObjectId = exaTemplate.configObjectId;
            state.exaServerKey = exaTemplate.serverKey;
            ctx.output("directory-template", JSON.stringify({ directory, context7, context7Template: template, exa, exaTemplate }, null, 2));
          },
        });
      },
    },
    {
      name: "Configure a directory template into a connection-backed plugin instance",
      run: async (ctx) => {
        await ctx.prove("Configuring the Context7 template creates an External MCP Connection bound to its plugin item", {
          voiceover: vo[1],
          assert: async () => {
            const templates = await apiJson(ctx, `/v1/plugins/${encodeURIComponent(state.context7PluginId)}/server-templates`);
            const template = (templates.item?.mcpTemplates ?? []).find((entry) => entry.serverKey === state.context7ServerKey);
            ctx.assert(Boolean(template), "Context7 template disappeared before configuration.");
            const configured = await apiJson(ctx, `/v1/plugins/${encodeURIComponent(state.context7PluginId)}/server-instances`, {
              method: "POST",
              body: JSON.stringify({
                access: { orgWide: true, memberIds: [], teamIds: [] },
                authType: "none",
                configObjectId: template.configObjectId,
                credentialMode: "shared",
                instanceLabel: `fraimz-${Date.now().toString(36)}`,
                name: `Context7 fraimz ${Date.now().toString(36)}`,
                serverKey: template.serverKey,
              }),
            });
            state.context7ConnectionId = configured.item?.externalMcpConnectionId ?? "";
            ctx.assert(state.context7ConnectionId.startsWith("emc_"), `Missing configured connection id: ${JSON.stringify(configured)}`);

            const connections = await apiJson(ctx, "/v1/mcp-connections?scope=usable");
            const connection = (connections.connections ?? []).find((entry) => entry.id === state.context7ConnectionId);
            ctx.assert(Boolean(connection), `Configured connection missing from usable list: ${JSON.stringify(connections.connections ?? [])}`);
            ctx.assert(connection.pluginId === state.context7PluginId, `Connection plugin binding mismatch: ${JSON.stringify(connection)}`);
            ctx.assert(connection.serverKey === template.serverKey, `Connection server key mismatch: ${JSON.stringify(connection)}`);
            ctx.assert(connection.authType === "none", `Connection auth mismatch: ${connection.authType}`);
            ctx.output("configured-directory-instance", JSON.stringify({ configured: configured.item, connection }, null, 2));
          },
        });
      },
    },
    {
      name: "Configure an API-key directory template without plugin-owned secrets",
      run: async (ctx) => {
        await ctx.prove("Configuring the Exa template stores the API key on the External MCP Connection and binds the instance to the plugin item", {
          voiceover: vo[2],
          assert: async () => {
            const configured = await apiJson(ctx, `/v1/plugins/${encodeURIComponent(state.exaPluginId)}/server-instances`, {
              method: "POST",
              body: JSON.stringify({
                access: { orgWide: true, memberIds: [], teamIds: [] },
                authType: "apikey",
                configObjectId: state.exaConfigObjectId,
                credentialMode: "shared",
                fieldValues: [{ key: "api_key", value: `fraimz-${Date.now().toString(36)}` }],
                instanceLabel: `fraimz-${Date.now().toString(36)}`,
                name: `Exa fraimz ${Date.now().toString(36)}`,
                serverKey: state.exaServerKey,
              }),
            });
            state.exaConnectionId = configured.item?.externalMcpConnectionId ?? "";
            ctx.assert(state.exaConnectionId.startsWith("emc_"), `Missing Exa connection id: ${JSON.stringify(configured)}`);

            const connections = await apiJson(ctx, "/v1/mcp-connections?scope=manageable");
            const connection = (connections.connections ?? []).find((entry) => entry.id === state.exaConnectionId);
            ctx.assert(Boolean(connection), `Configured Exa connection missing from manageable list: ${JSON.stringify(connections.connections ?? [])}`);
            ctx.assert(connection.pluginId === state.exaPluginId, `Exa connection plugin binding mismatch: ${JSON.stringify(connection)}`);
            ctx.assert(connection.authType === "apikey", `Exa connection auth mismatch: ${connection.authType}`);
            ctx.assert(connection.credentialMode === "shared", `Exa connection credential mode mismatch: ${connection.credentialMode}`);

            const templates = await apiJson(ctx, `/v1/plugins/${encodeURIComponent(state.exaPluginId)}/server-templates`);
            const templatePayload = JSON.stringify(templates.item?.mcpTemplates ?? []);
            ctx.assert(!templatePayload.includes("fraimz-"), "API key leaked into plugin template response.");
            ctx.output("configured-api-key-instance", JSON.stringify({
              configured: configured.item,
              connection: {
                id: connection.id,
                authType: connection.authType,
                credentialMode: connection.credentialMode,
                pluginId: connection.pluginId,
              },
            }, null, 2));
          },
        });
      },
    },
    {
      name: "Import a GitHub plugin skill and find it through capabilities",
      run: async (ctx) => {
        await ctx.prove("A skill imported from a GitHub plugin URL is searchable and executable through /mcp/agent", {
          voiceover: vo[3],
          assert: async () => {
            const preview = await apiJson(ctx, "/v1/plugins/import-mcps-from-github-url/preview", {
              method: "POST",
              body: JSON.stringify({ githubUrl: GITHUB_PLUGIN_URL }),
            });
            const skill = (preview.item?.skills ?? []).find((entry) => entry.supported);
            ctx.assert(Boolean(skill), `No supported skills discovered in ${GITHUB_PLUGIN_URL}: ${JSON.stringify(preview.item?.skills ?? [])}`);
            state.importedSkillName = skill.name;

            const imported = await apiJson(ctx, "/v1/plugins/import-mcps-from-github-url", {
              method: "POST",
              body: JSON.stringify({
                access: { orgWide: true, memberIds: [], teamIds: [] },
                authType: "oauth",
                credentialMode: "per_member",
                githubUrl: GITHUB_PLUGIN_URL,
                marketplaceId: state.marketplaceId,
                selectedServerKeys: [SENTINEL_SERVER_KEY],
                selectedSkillKeys: [skill.skillKey],
              }),
            });
            state.importedPluginId = imported.item?.plugin?.id ?? "";
            ctx.assert(state.importedPluginId.startsWith("plg_"), `Import response missing plugin id: ${JSON.stringify(imported).slice(0, 500)}`);

            const memberships = await apiJson(ctx, `/v1/plugins/${encodeURIComponent(state.importedPluginId)}/config-objects`);
            const skillMembership = (memberships.items ?? []).find((entry) => entry.configObject?.objectType === "skill");
            state.importedConfigObjectId = skillMembership?.configObjectId ?? "";
            state.importedSkillId = skillMembership?.configObject?.denSkillId ?? "";
            ctx.assert(state.importedConfigObjectId.startsWith("cob_"), `Missing imported skill config object: ${JSON.stringify(memberships.items ?? [])}`);
            ctx.assert(state.importedSkillId.startsWith("skl_"), `Missing imported Den skill id: ${JSON.stringify(skillMembership)}`);

            const tokenResponse = await apiJson(ctx, "/v1/mcp/token", { method: "POST", body: "{}" });
            state.mcpToken = tokenResponse.token;
            ctx.assert(typeof state.mcpToken === "string" && state.mcpToken.length > 20, "MCP token was not returned.");

            const search = await mcpAgentCall(ctx, "tools/call", {
              name: "search_capabilities",
              arguments: { query: state.importedSkillName, limit: 8 },
            });
            const searchJson = parseToolJson(search);
            const match = (searchJson.matches ?? []).find((entry) => entry.name === `skill:${state.importedSkillId}`);
            ctx.assert(Boolean(match), `Imported skill missing from search_capabilities: ${toolText(search).slice(0, 800)}`);

            const executed = await mcpAgentCall(ctx, "tools/call", {
              name: "execute_capability",
              arguments: { name: match.name },
            });
            const executedJson = parseToolJson(executed);
            ctx.assert(executedJson.skill?.id === state.importedSkillId, `execute_capability returned the wrong skill: ${toolText(executed).slice(0, 800)}`);
            ctx.assert(typeof executedJson.skill?.skillText === "string" && executedJson.skill.skillText.includes("name:"), "Executed skill did not include SKILL.md content.");
            ctx.output("imported-skill-capability", JSON.stringify({
              imported: imported.item?.importedSkills,
              match,
              skill: {
                id: executedJson.skill?.id,
                title: executedJson.skill?.title,
                textPrefix: executedJson.skill?.skillText?.slice(0, 240),
              },
            }, null, 2));
          },
        });
      },
    },
    {
      name: "Disable the imported skill and verify capability removal",
      run: async (ctx) => {
        await ctx.prove("Turning the imported skill item inactive removes it from search and direct execution", {
          voiceover: vo[4],
          assert: async () => {
            await apiJson(ctx, `/v1/config-objects/${encodeURIComponent(state.importedConfigObjectId)}/status`, {
              method: "PUT",
              body: JSON.stringify({ status: "inactive" }),
            });

            const search = await mcpAgentCall(ctx, "tools/call", {
              name: "search_capabilities",
              arguments: { query: state.importedSkillName, limit: 12 },
            });
            const searchJson = parseToolJson(search);
            const hidden = !(searchJson.matches ?? []).some((entry) => entry.name === `skill:${state.importedSkillId}`);
            ctx.assert(hidden, `Inactive imported skill still appeared in search_capabilities: ${toolText(search).slice(0, 800)}`);

            const executed = await mcpAgentCall(ctx, "tools/call", {
              name: "execute_capability",
              arguments: { name: `skill:${state.importedSkillId}` },
            });
            ctx.assert(executed.isError === true, `Inactive imported skill should not execute: ${toolText(executed).slice(0, 800)}`);
            await apiJson(ctx, `/v1/config-objects/${encodeURIComponent(state.importedConfigObjectId)}/status`, {
              method: "PUT",
              body: JSON.stringify({ status: "active" }),
            });
            ctx.output("disabled-skill-capability", JSON.stringify({ directExecuteIsError: executed.isError, searchMatches: searchJson.matches?.length ?? 0 }, null, 2));
          },
        });
      },
    },
  ],
};
