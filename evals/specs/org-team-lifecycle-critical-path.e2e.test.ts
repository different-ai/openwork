import { expect, onTestFinished } from "vitest";
import type { Surface } from "@openwork/cdp";
import {
  assignPluginToMarketplace,
  control,
  createMarketplace,
  createOrgConnection,
  denFetch,
  evalIn,
  go,
  grantMarketplaceAccess,
  readAvailableModels,
  readCurrentOrganizationMemberId,
  readResolvedMarketplace,
  selectModel,
  sendComposerMessage,
  waitFor,
  waitForAssistantReply,
  waitForButtonGone,
} from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/test-evidence";
import {
  app,
  eventually,
  inviteMember,
  mcpMock,
  needs,
  readCloudMcpHealth,
  server,
  test,
  unmetNeeds,
} from "@openwork/testkit";
import type { TestNeeds } from "@openwork/testkit";

/**
 * CRITICAL-PATH E2E JOURNEY: a new organization invites a second person, publishes a real
 * model and a shared connector, authors a Cloud skill from the admin desktop,
 * shares that skill through a person-scoped marketplace, and proves from a
 * sequential teammate desktop that the real model runs and the shared skill
 * uses the organization connector.
 * It also claims each desktop's openwork-cloud MCP health and direct tool probe.
 *
 * Step-0 research (2026-08-09): the preferred path exists today. The signed-in
 * app reconciler requires an active org, mints a fresh token, and repairs the
 * `openwork-cloud` entry (apps/app/src/react-app/domains/connections/store.ts:
 * 883-927). The desktop server persists and dynamically registers that remote
 * MCP with the engine (apps/server/src/cloud-mcp-health.ts:2112-2123). The server
 * reads Den's remote skill index (apps/server/src/connect-skill-catalog.ts:45-78,
 * 98-124), and its per-request steering tells the agent to execute the exact
 * remote skill capability (apps/server/src/connect-skill-catalog.ts:152-179).
 * Den exposes only search_capabilities/execute_capability to that agent and
 * explicitly advertises create-skill (ee/apps/den-api/src/mcp/agent.ts:119-135).
 * The create-skill document directs the agent to call postPlugins with a full
 * SKILL.md, then getPluginsResolved, without org-wide or marketplace access
 * (ee/apps/den-api/src/mcp/builtin-skills.ts:15-68). Therefore this spec asks
 * the admin's real chat agent to use `skill:create-skill`; Den plugin state is
 * the witness. The API-publish fallback is intentionally not used.
 *
 * Since #3703 (2026-08-12), org providers reach desktops, so the picker lists
 * this model twice. The org `critical-path-openai` copy uses
 * `@ai-sdk/openai-compatible`, which sends `max_tokens`; current OpenAI reasoning
 * models require `max_completion_tokens`. This journey therefore pins the native
 * workspace-config "OpenAI" group, resolving the ambiguity tracked in #3813.
 */

// 2026-08-10: the Den-hosted Automation phase was removed after Den never materialized a run row
// (latestRun stayed null past 420s with state=active) on the Daytona lane. Automation coverage stays
// owned by automations-den-hosted.e2e.test.ts; see the PR's follow-up note.

const requirements: TestNeeds = {
  model: "tool-capable",
  env: ["OPENAI_API_KEY"],
  optIn: ["OPENWORK_EVAL_E2E_TESTS", "OPENWORK_EVAL_CRITICAL_PATH_E2E_JOURNEY"],
};
const missingRequirements = unmetNeeds(requirements, process.env);
const title = missingRequirements.length > 0
  ? `org team lifecycle critical-path E2E journey skipped — needs: ${missingRequirements.join(", ")}`
  : "a new org goes from empty to a working two-person team";

const REQUEST_TIMEOUT_MS = 30_000;
const CUSTOM_PROVIDER_ID = "critical-path-openai";
let gatewayRequestId = 0;

interface OrganizationMembership {
  id: string;
  membershipId: string;
  name: string;
  role: string;
}

interface ProviderTarget {
  apiKey: string;
  catalogModelId: string;
  requestedModelId: string;
}

interface ProviderFacts {
  id: string;
  modelIds: string[];
  name: string;
  providerId: string;
}

interface PluginWitness {
  configObjectId: string;
  id: string;
  name: string;
  rawSourceText: string;
  skillName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveProviderTarget(): ProviderTarget {
  const requestedModelId = process.env.OPENWORK_EVAL_MODEL?.trim() ?? "";
  if (!requestedModelId || requestedModelId.includes("/")) {
    throw new Error(`OPENWORK_EVAL_MODEL must be the bare OpenAI model id; received ${requestedModelId}.`);
  }
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? "";
  if (!apiKey) throw new Error(`${requestedModelId} requires OPENAI_API_KEY.`);
  // Anthropic keys can use Anthropic's OpenAI-compatible endpoint in a later extension of this eval.
  return { apiKey, catalogModelId: requestedModelId, requestedModelId };
}

async function organizationMembership(session: DenSession, organizationName: string): Promise<OrganizationMembership> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: auth(session),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const org = isRecord(result.body)
    ? records(result.body.orgs).find((candidate) => candidate.name === organizationName)
    : undefined;
  const membership = org && {
    id: stringField(org.id),
    membershipId: stringField(org.membershipId) || stringField(org.orgMemberId),
    name: stringField(org.name),
    role: stringField(org.role),
  };
  if (!result.response.ok || !membership?.id || !membership.membershipId) {
    throw new Error(`Finding ${organizationName} for ${session.email} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return membership;
}

async function readProviders(session: DenSession, orgId: string): Promise<ProviderFacts[]> {
  const result = await denFetch(session, "/v1/llm-providers", {
    headers: { ...auth(session), "x-openwork-org-id": orgId },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!result.response.ok) {
    throw new Error(`Listing providers failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  const providers = isRecord(result.body) ? records(result.body.llmProviders) : [];
  return providers.map((provider) => ({
    id: stringField(provider.id),
    modelIds: records(provider.models).map((model) => stringField(model.id)).filter(Boolean),
    name: stringField(provider.name),
    providerId: stringField(provider.providerId),
  }));
}

async function createProvider(
  admin: DenSession,
  orgId: string,
  name: string,
  target: ProviderTarget,
): Promise<string> {
  const result = await denFetch(admin, "/v1/llm-providers", {
    method: "POST",
    headers: { ...auth(admin), "x-openwork-org-id": orgId },
    body: JSON.stringify({
      name,
      source: "custom",
      customConfig: {
        id: CUSTOM_PROVIDER_ID,
        name,
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: "https://api.openai.com/v1" },
        env: ["MEGA_EVAL_PROVIDER_KEY"],
        models: [{ id: target.catalogModelId, name: `OpenAI ${target.catalogModelId}` }],
      },
      apiKey: target.apiKey,
      allMembers: true,
      memberIds: [],
      teamIds: [],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.llmProvider) ? result.body.llmProvider : null;
  const providerId = provider ? stringField(provider.id) : "";
  if (result.response.status !== 201 || !providerId) {
    throw new Error(`Creating provider failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return providerId;
}

async function deleteProvider(admin: DenSession, orgId: string, providerId: string): Promise<void> {
  const result = await denFetch(admin, `/v1/llm-providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
    headers: { ...auth(admin), "x-openwork-org-id": orgId },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!result.response.ok && result.response.status !== 404) {
    throw new Error(`Deleting provider failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
}

async function configureWorkspaceOpenAi(appSurface: Surface, workspaceId: string, apiKey: string): Promise<void> {
  const providerConfigured = await evalIn(appSurface, `(async () => {
    const port = localStorage.getItem("openwork.server.port");
    const token = localStorage.getItem("openwork.server.token");
    if (!port || !token) return "missing local server credentials";
    const request = async (path, init) => {
      const response = await fetch("http://127.0.0.1:" + port + path, {
        ...init,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      });
      if (!response.ok) return path + " failed: " + response.status + " " + (await response.text()).slice(0, 300);
      return "ok";
    };
    const workspaceId = ${JSON.stringify(workspaceId)};
    const patched = await request("/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      body: JSON.stringify({ opencode: { provider: { openai: { options: { apiKey: ${JSON.stringify(apiKey)} } } } } }),
    });
    if (patched !== "ok") return patched;
    return request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
  })()`, { awaitPromise: true, timeoutMs: 60_000 });
  expect(providerConfigured).toBe("ok");
}

async function selectableWorkspaceModel(appSurface: Surface, target: ProviderTarget): Promise<string> {
  const facts = await eventually(async () => {
    const models = await readAvailableModels(appSurface);
    const match = models.find((model) => (
      model.selectable && model.id === target.requestedModelId && model.providerName === "OpenAI"
    ));
    return { match, models };
  }, {
    within: 180_000,
    intervalMs: 5_000,
    label: `${target.requestedModelId} selectable in workspace-config OpenAI provider group`,
    until: (value) => Boolean(value.match),
  });
  if (!facts.match) throw new Error(`${target.requestedModelId} did not become selectable through workspace config.`);
  return facts.match.id;
}

async function readAuthoredPlugin(
  admin: DenSession,
  pluginName: string,
  nonce: string,
): Promise<PluginWitness | null> {
  const listed = await denFetch(admin, `/v1/plugins?q=${encodeURIComponent(pluginName)}&limit=20`, {
    headers: auth(admin),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!listed.response.ok || !isRecord(listed.body)) return null;
  const plugin = records(listed.body.items).find((candidate) => candidate.name === pluginName);
  const pluginId = plugin ? stringField(plugin.id) : "";
  if (!plugin || !pluginId) return null;

  const resolved = await denFetch(admin, `/v1/plugins/${encodeURIComponent(pluginId)}/resolved`, {
    headers: auth(admin),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!resolved.response.ok || !isRecord(resolved.body)) return null;
  for (const item of records(resolved.body.items)) {
    if (!isRecord(item.configObject)) continue;
    const configObject = item.configObject;
    if (configObject.objectType !== "skill" || !isRecord(configObject.latestVersion)) continue;
    const rawSourceText = stringField(configObject.latestVersion.rawSourceText);
    if (!rawSourceText.includes(nonce)) continue;
    return {
      configObjectId: stringField(configObject.id),
      id: pluginId,
      name: stringField(plugin.name),
      rawSourceText,
      skillName: stringField(configObject.title),
    };
  }
  return null;
}

async function mintGatewayToken(session: DenSession, orgId: string): Promise<string> {
  const result = await denFetch(session, "/v1/mcp/token", {
    method: "POST",
    headers: { ...auth(session), "x-openwork-org-id": orgId },
    body: JSON.stringify({}),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const token = isRecord(result.body) ? stringField(result.body.token) : "";
  if (!result.response.ok || !token.startsWith("ow_mcp_at_")) {
    throw new Error(`Minting MCP token failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return token;
}

async function callGatewayTool(
  apiUrl: string,
  token: string,
  name: "execute_capability" | "search_capabilities",
  args: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(`${apiUrl.replace(/\/+$/, "")}/mcp/agent`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: ++gatewayRequestId,
      method: "tools/call",
      params: { name, arguments: args },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`Gateway tools/call failed: HTTP ${response.status} ${raw.slice(0, 500)}`);
  const dataLine = raw.split("\n").find((line) => line.startsWith("data:"));
  const payloadText = dataLine ? dataLine.slice(5) : raw;
  const payload: unknown = JSON.parse(payloadText);
  if (!isRecord(payload)) throw new Error(`Gateway returned a malformed JSON-RPC payload: ${raw.slice(0, 500)}`);
  if (payload.error) throw new Error(`Gateway returned a JSON-RPC error: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

function gatewayToolJson(result: unknown): unknown {
  if (!isRecord(result)) throw new Error(`Gateway result was not an object: ${JSON.stringify(result)}`);
  const first = Array.isArray(result.content) ? result.content[0] : null;
  if (!isRecord(first) || typeof first.text !== "string") {
    throw new Error(`Gateway result had no text content: ${JSON.stringify(result).slice(0, 500)}`);
  }
  return JSON.parse(first.text);
}

function gatewaySearchMatches(result: unknown): Record<string, unknown>[] {
  const payload = gatewayToolJson(result);
  return isRecord(payload) ? records(payload.matches) : [];
}

test.skipIf(missingRequirements.length > 0)(title, { timeout: 45 * 60_000 }, async ({ evidence, place }) => {
  needs(requirements);
  const target = resolveProviderTarget();
  const stamp = Date.now();
  const organizationName = `Mega Lifecycle ${stamp}`;
  const providerName = `Mega OpenAI Models ${stamp}`;
  const teammateEmail = `taylor.critical-path.${stamp}@acme.test`;
  const outsiderEmail = `riley.critical-path.${stamp}@acme.test`;
  const password = "OpenWorkEval123!";
  // The authored skill's marker must survive verbatim model reproduction, so keep it short (base36), like llmNonce below.
  const skillNonce = `critical-path-${stamp.toString(36)}`;
  const skillName = `critical-path-echo-${stamp}`;
  const pluginName = `Mega Echo Plugin ${stamp}`;
  const skillMarker = `SKILL-USED-${skillNonce}`;

  await using den = await server({
    place,
    mocks: { connector: mcpMock({ port: 3983, allowUnauthenticatedMcp: true }) },
    org: {
      name: organizationName,
      members: {
        outsider: { email: outsiderEmail, name: "Riley Mega", password },
      },
    },
  });
  const connector = den.mocks.connector;
  const outsider = den.members.outsider;
  if (!outsider) throw new Error("The testkit did not provision the outsider member.");

  await createOrgConnection(den.admin, {
    name: `Mega Echo Connection ${stamp}`,
    url: connector.mcpUrl,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  });

  const adminMembership = await organizationMembership(den.admin, organizationName);
  const orgId = adminMembership.id;
  const teammate = await inviteMember(den, "teammate", {
    email: teammateEmail,
    name: "Taylor Mega",
    password,
  });
  const teammateMembership = await organizationMembership(teammate, organizationName);
  expect(teammateMembership.role).toBe("member");
  expect(teammateMembership.role).not.toMatch(/admin|owner/i);
  evidence.recordAssertionEvidence(
    "The invited teammate is a plain organization member",
    `${teammateEmail} sees ${organizationName} with role=${teammateMembership.role}, not admin or owner.`,
    teammateMembership.role === "member",
  );

  const providerBaseline = await readProviders(teammate, orgId);
  const baselineModels = providerBaseline.flatMap((provider) => provider.modelIds);
  const providerAbsentBeforePublish = !providerBaseline.some((provider) => provider.name === providerName);
  const providerModelAbsentBeforePublish = !providerBaseline.some((provider) => (
    provider.name === providerName && provider.modelIds.includes(target.catalogModelId)
  ));
  expect(providerAbsentBeforePublish).toBe(true);
  expect(providerModelAbsentBeforePublish).toBe(true);
  evidence.recordAssertionEvidence(
    "The teammate cannot see the lifecycle provider before it is published",
    `Provider baseline: ${JSON.stringify(providerBaseline.map((provider) => provider.name))}; model baseline: ${JSON.stringify(baselineModels)}.`,
    providerAbsentBeforePublish,
  );

  // Since #3703 (2026-08-12), org providers reach desktops and duplicate this model.
  // The org openai-compatible copy sends rejected max_tokens, so #3813 is avoided by
  // pinning this journey to the native workspace-config "OpenAI" group below.
  const providerId = await createProvider(den.admin, orgId, providerName, target);
  onTestFinished(async () => {
    await deleteProvider(den.admin, orgId, providerId).catch(() => undefined);
  });
  const teammateProviders = await eventually(
    () => readProviders(teammate, orgId),
    {
      within: 60_000,
      label: "teammate provider entitlement",
      until: (providers) => providers.some((provider) => provider.id === providerId),
    },
  );
  const publishedProvider = teammateProviders.find((provider) => provider.id === providerId);
  expect(publishedProvider?.providerId).toBe(CUSTOM_PROVIDER_ID);
  expect(publishedProvider?.modelIds).toContain(target.catalogModelId);

  const teammateGatewayToken = await mintGatewayToken(teammate, orgId);
  const adminGatewayToken = await mintGatewayToken(den.admin, orgId);
  let pluginWitness: PluginWitness | null = null;
  let skillCapabilityName = "";

  {
    await using appAdmin = await app({ den, as: "admin", place });
    await configureWorkspaceOpenAi(appAdmin, appAdmin.workspaceId, target.apiKey);
    await go(appAdmin, `/workspace/${appAdmin.workspaceId}/session`);
    const adminModelId = await selectableWorkspaceModel(appAdmin, target);
    const selectedAdminModel = await selectModel(appAdmin, adminModelId, { provider: "OpenAI" });
    expect(selectedAdminModel.selected).toBe(true);
    evidence.recordAssertionEvidence(
      "The admin's real OpenAI model is selectable through workspace config",
      `Workspace ${appAdmin.workspaceId} selected ${adminModelId} after the config patch and engine reload.`,
      true,
    );

    // This doubles as a fail-fast gate: a broken connector fails here in seconds with a named phase instead of surfacing as the 420s authoring timeout downstream.
    const adminCloudMcp = await eventually(
      () => readCloudMcpHealth(appAdmin, appAdmin.workspaceId, { probe: true }),
      {
        within: 180_000,
        intervalMs: 5_000,
        label: "admin openwork-cloud MCP ready",
        until: (h) => h.ok && h.phase === "ready" && h.direct.checked && h.direct.missing.length === 0,
      },
    );
    expect(adminCloudMcp.phase).toBe("ready");
    expect(adminCloudMcp.usable).toBe(true);
    expect(adminCloudMcp.engineStatus).toBe("connected");
    expect(adminCloudMcp.direct.source).toBe("mcp_tools_list");
    expect(adminCloudMcp.direct.present).toEqual(expect.arrayContaining(["search_capabilities", "execute_capability"]));
    expect(adminCloudMcp.direct.missing).toEqual([]);
    expect(adminCloudMcp.tools.missing).toEqual([]);
    expect(adminCloudMcp.direct.present).not.toContain("mock_echo");
    expect(adminCloudMcp.tools.present).not.toContain("mock_echo");
    const adminCloudMcpReady = adminCloudMcp.ok
      && adminCloudMcp.phase === "ready"
      && adminCloudMcp.usable === true
      && adminCloudMcp.engineStatus === "connected"
      && adminCloudMcp.direct.checked
      && adminCloudMcp.direct.source === "mcp_tools_list"
      && adminCloudMcp.direct.present.includes("search_capabilities")
      && adminCloudMcp.direct.present.includes("execute_capability")
      && adminCloudMcp.direct.missing.length === 0
      && adminCloudMcp.tools.missing.length === 0;
    evidence.recordAssertionEvidence(
      "The admin desktop's OpenWork Connect MCP connector is registered and live-probed ready",
      `Health phase=${adminCloudMcp.phase}, engine=${adminCloudMcp.engineStatus}, probed tools=${JSON.stringify(adminCloudMcp.direct.present)}.`,
      adminCloudMcpReady,
    );
    const adminGatewaySurfaceOnly = !adminCloudMcp.direct.present.includes("mock_echo")
      && !adminCloudMcp.tools.present.includes("mock_echo");
    evidence.recordAssertionEvidence(
      "The Connect tool list is exactly the gateway surface",
      `mock_echo is absent from direct tools ${JSON.stringify(adminCloudMcp.direct.present)} and registered tools ${JSON.stringify(adminCloudMcp.tools.present)}.`,
      adminGatewaySurfaceOnly,
    );

    await sendComposerMessage(appAdmin, [
      "Create exactly one OpenWork Cloud skill, not a local skill.",
      "Load and follow the remote create-skill capability `skill:create-skill`, then verify the created plugin.",
      `Use skill name ${skillName} and plugin title ${pluginName}.`,
      `The complete SKILL.md must contain nonce ${skillNonce}.`,
      `Its instructions must say that whenever the skill is used, the agent searches for and calls the organization connector tool mock_echo with text exactly ${skillMarker}.`,
      "Do not grant org-wide access and do not attach it to a marketplace.",
    ].join(" "));

    const authoringStartedAt = Date.now();
    let authoringNudgeFired = false;
    try {
      pluginWitness = await eventually(
        () => readAuthoredPlugin(den.admin, pluginName, skillNonce),
        {
          within: 180_000,
          intervalMs: 2_000,
          label: "Cloud skill authored before a follow-up nudge",
          until: (plugin) => plugin !== null,
        },
      );
    } catch {
      pluginWitness = await readAuthoredPlugin(den.admin, pluginName, skillNonce);
      if (!pluginWitness) {
        authoringNudgeFired = true;
        await sendComposerMessage(
          appAdmin,
          `Continue now: call execute_capability with name skill:create-skill, follow its instructions to create the plugin ${pluginName} via postPlugins with the full SKILL.md for ${skillName} (it must contain ${skillNonce} and the mock_echo instruction with ${skillMarker}), then stop.`,
        );
        const remainingMs = Math.max(1, 420_000 - (Date.now() - authoringStartedAt));
        pluginWitness = await eventually(
          () => readAuthoredPlugin(den.admin, pluginName, skillNonce),
          {
            within: remainingMs,
            intervalMs: 2_000,
            label: "Cloud skill authored after one follow-up nudge",
            until: (plugin) => plugin !== null,
          },
        );
      }
    }
    evidence.recordAssertionEvidence(
      "Cloud skill authoring needed a follow-up nudge",
      `Follow-up nudge fired: ${authoringNudgeFired}. The authoring witness had a 420-second total budget.`,
      true,
    );
    if (!pluginWitness) throw new Error("The admin chat did not create the expected Cloud skill.");
    expect(pluginWitness.rawSourceText).toContain(skillNonce);
    expect(pluginWitness.rawSourceText).toContain(skillMarker);
    expect(pluginWitness.rawSourceText).toContain("mock_echo");
    const authorReply = await waitForAssistantReply(appAdmin, { timeoutMs: 300_000 });
    evidence.recordAssertionEvidence(
      "The admin desktop chat authored and published the Cloud skill",
      `Plugin ${pluginWitness.id} contains skill ${pluginWitness.skillName}; assistant reply: ${authorReply.text.slice(0, 500)}.`,
      true,
    );

    const adminSkillMatch = await eventually(async () => {
      const search = await callGatewayTool(den.ref.apiUrl, adminGatewayToken, "search_capabilities", {
        query: skillName,
        limit: 20,
        type: "skills",
      });
      return gatewaySearchMatches(search).find((match) => (
        typeof match.name === "string" && match.name.startsWith(`plugin:${pluginWitness?.id ?? "missing"}:`)
      )) ?? null;
    }, {
      within: 60_000,
      label: "creator gateway skill capability",
      until: (match) => match !== null,
    });
    skillCapabilityName = adminSkillMatch ? stringField(adminSkillMatch.name) : "";
    if (!skillCapabilityName) throw new Error("The creator could not discover the chat-authored skill capability.");

    const deniedSkillSearch = await callGatewayTool(den.ref.apiUrl, teammateGatewayToken, "search_capabilities", {
      query: skillName,
      limit: 20,
      type: "skills",
    });
    const deniedAllSearch = await callGatewayTool(den.ref.apiUrl, teammateGatewayToken, "search_capabilities", {
      query: skillName,
      limit: 20,
    });
    const teammateFoundBeforeGrant = [...gatewaySearchMatches(deniedSkillSearch), ...gatewaySearchMatches(deniedAllSearch)]
      .some((match) => match.name === skillCapabilityName);
    expect(teammateFoundBeforeGrant).toBe(false);
    evidence.recordAssertionEvidence(
      "The teammate cannot discover the creator-only skill before the grant",
      `Both skills-only and all-capability searches omitted ${skillCapabilityName}.`,
      !teammateFoundBeforeGrant,
    );

    const deniedExecution = await callGatewayTool(den.ref.apiUrl, teammateGatewayToken, "execute_capability", {
      name: skillCapabilityName,
    });
    const deniedRecord = isRecord(deniedExecution) ? deniedExecution : {};
    const deniedPayload = gatewayToolJson(deniedExecution);
    expect(deniedRecord.isError).toBe(true);
    expect(deniedPayload).toEqual({
      error: "forbidden",
      message: "You have not been granted access to this plugin capability.",
    });
    evidence.recordAssertionEvidence(
      "The teammate cannot execute the creator-only skill before the grant",
      `execute_capability returned ${JSON.stringify(deniedPayload)}.`,
      deniedRecord.isError === true && isRecord(deniedPayload) && deniedPayload.error === "forbidden",
    );

    // The Den-state witness above can land while the agent is still narrating
    // its verification turn; wait for the run to go idle so the screenshot
    // shows the completed task instead of a mid-run "Thinking…" state.
    await waitForButtonGone(appAdmin, "Stop", { timeoutMs: 240_000 });
    const shot = await screenshot(appAdmin);
    const seen = await validate(shot, [
      "An OpenWork chat surface shows the admin's completed Cloud skill creation task",
      "No 'Something went wrong', blank screen, or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  if (!pluginWitness || !skillCapabilityName) throw new Error("Cloud skill authoring did not produce shareable facts.");
  const archivedPluginId = pluginWitness.id;
  onTestFinished(async () => {
    await denFetch(den.admin, `/v1/plugins/${encodeURIComponent(archivedPluginId)}/archive`, {
      method: "POST",
      headers: auth(den.admin),
    }).catch(() => undefined);
  });

  const marketplace = await createMarketplace(den.admin, {
    name: `Mega Team Marketplace ${stamp}`,
    description: "Person-scoped marketplace for the two-person lifecycle eval.",
  });
  await assignPluginToMarketplace(den.admin, marketplace.id, pluginWitness.id);
  const teammateMemberId = await readCurrentOrganizationMemberId(teammate);
  expect(teammateMemberId).toBe(teammateMembership.membershipId);
  await grantMarketplaceAccess(den.admin, marketplace.id, { orgMembershipId: teammateMemberId });

  const teammateMarketplace = await readResolvedMarketplace(teammate, marketplace.id);
  const teammateSeesPlugin = teammateMarketplace.pluginNames.includes(pluginWitness.name);
  const teammateSeesSkill = teammateMarketplace.skillNames.includes(pluginWitness.skillName);
  expect(teammateSeesPlugin).toBe(true);
  expect(teammateSeesSkill).toBe(true);

  let outsiderMarketplace: Awaited<ReturnType<typeof readResolvedMarketplace>> | null = null;
  let outsiderReadError = "";
  try {
    outsiderMarketplace = await readResolvedMarketplace(outsider, marketplace.id);
  } catch (error) {
    outsiderReadError = errorText(error);
  }
  const outsiderSeesPlugin = outsiderMarketplace?.pluginNames.includes(pluginWitness.name) === true;
  const outsiderSeesSkill = outsiderMarketplace?.skillNames.includes(pluginWitness.skillName) === true;
  expect(outsiderSeesPlugin).toBe(false);
  expect(outsiderSeesSkill).toBe(false);
  evidence.recordAssertionEvidence(
    "The ungranted outsider cannot see the person-scoped marketplace content",
    outsiderMarketplace
      ? `Outsider plugins=${JSON.stringify(outsiderMarketplace.pluginNames)}, skills=${JSON.stringify(outsiderMarketplace.skillNames)}.`
      : `The outsider's resolved-marketplace read was denied: ${outsiderReadError}`,
    !outsiderSeesPlugin && !outsiderSeesSkill,
  );

  await eventually(async () => {
    const result = await callGatewayTool(den.ref.apiUrl, teammateGatewayToken, "search_capabilities", {
      query: skillName,
      limit: 20,
      type: "skills",
    });
    return gatewaySearchMatches(result).some((match) => match.name === skillCapabilityName);
  }, {
    within: 120_000,
    intervalMs: 2_000,
    label: "shared skill visible through teammate gateway",
  });

  {
    await using appMate = await app({ den, as: "teammate", place });
    await configureWorkspaceOpenAi(appMate, appMate.workspaceId, target.apiKey);
    await go(appMate, `/workspace/${appMate.workspaceId}/session`);
    const teammateModelId = await selectableWorkspaceModel(appMate, target);
    const selectedTeammateModel = await selectModel(appMate, teammateModelId, { provider: "OpenAI" });
    expect(selectedTeammateModel.selected).toBe(true);
    evidence.recordAssertionEvidence(
      "The teammate's real OpenAI model is selectable through workspace config",
      `Workspace ${appMate.workspaceId} selected ${teammateModelId} after the config patch and engine reload.`,
      true,
    );

    // This turns the later mock_echo connector witness into a checked-precondition round-trip rather than an inference.
    const teammateCloudMcp = await eventually(
      () => readCloudMcpHealth(appMate, appMate.workspaceId, { probe: true }),
      {
        within: 180_000,
        intervalMs: 5_000,
        label: "teammate openwork-cloud MCP ready",
        until: (h) => h.ok && h.phase === "ready" && h.direct.checked && h.direct.missing.length === 0,
      },
    );
    expect(teammateCloudMcp.phase).toBe("ready");
    expect(teammateCloudMcp.usable).toBe(true);
    expect(teammateCloudMcp.engineStatus).toBe("connected");
    expect(teammateCloudMcp.direct.source).toBe("mcp_tools_list");
    expect(teammateCloudMcp.direct.present).toEqual(expect.arrayContaining(["search_capabilities", "execute_capability"]));
    expect(teammateCloudMcp.direct.missing).toEqual([]);
    expect(teammateCloudMcp.tools.missing).toEqual([]);
    expect(teammateCloudMcp.direct.present).not.toContain("mock_echo");
    expect(teammateCloudMcp.tools.present).not.toContain("mock_echo");
    const teammateCloudMcpReady = teammateCloudMcp.ok
      && teammateCloudMcp.phase === "ready"
      && teammateCloudMcp.usable === true
      && teammateCloudMcp.engineStatus === "connected"
      && teammateCloudMcp.direct.checked
      && teammateCloudMcp.direct.source === "mcp_tools_list"
      && teammateCloudMcp.direct.present.includes("search_capabilities")
      && teammateCloudMcp.direct.present.includes("execute_capability")
      && teammateCloudMcp.direct.missing.length === 0
      && teammateCloudMcp.tools.missing.length === 0;
    evidence.recordAssertionEvidence(
      "The plain-member desktop's OpenWork Connect MCP connector is registered and live-probed ready",
      `Health phase=${teammateCloudMcp.phase}, engine=${teammateCloudMcp.engineStatus}, probed tools=${JSON.stringify(teammateCloudMcp.direct.present)}.`,
      teammateCloudMcpReady,
    );
    const teammateGatewaySurfaceOnly = !teammateCloudMcp.direct.present.includes("mock_echo")
      && !teammateCloudMcp.tools.present.includes("mock_echo");
    evidence.recordAssertionEvidence(
      "The plain member's Connect tool list is exactly the gateway surface",
      `mock_echo is absent from direct tools ${JSON.stringify(teammateCloudMcp.direct.present)} and registered tools ${JSON.stringify(teammateCloudMcp.tools.present)}.`,
      teammateGatewaySurfaceOnly,
    );

    // Small models drop digits from long decimal runs when echoing verbatim
    // (a 13-digit marker came back truncated); base36 keeps it short and
    // unique enough for one session.
    const llmNonce = stamp.toString(36);
    const llmMarker = `LLM-OK-${llmNonce}`;
    // A bare "reply with exactly <token>" prompt trips larger models' refusal
    // heuristics (gpt-4o answered "I can't assist with that"); frame the echo
    // as the connectivity check it actually is.
    await sendComposerMessage(
      appMate,
      `This is an automated connectivity check of the newly configured model. Reply with the verification code ${llmMarker} to confirm the model is reachable.`,
    );
    await waitFor(appMate, `([...document.querySelectorAll('[data-message-role="assistant"]')]
      .some((message) => (message.innerText ?? "").includes(${JSON.stringify(llmMarker)})))`, {
      timeoutMs: 300_000,
      label: `complete assistant verification code ${JSON.stringify(llmMarker)}`,
    });
    const llmReply = await waitForAssistantReply(appMate, { timeoutMs: 10_000 });
    expect(llmReply.text).toContain(llmMarker);
    evidence.recordAssertionEvidence(
      "The teammate ran the workspace-configured real model",
      `The assistant replied through ${teammateModelId}: ${llmReply.text.slice(0, 500)}.`,
      llmReply.text.includes(llmMarker),
    );

    await control(appMate, "session.create_task", undefined, { timeoutMs: 120_000 });
    await waitFor(appMate, `(() => {
      const editor = document.querySelector('[contenteditable="true"]');
      return Boolean(editor && document.querySelectorAll('[data-message-role="user"]').length === 0);
    })()`, { timeoutMs: 120_000, label: "fresh teammate skill session" });
    const skillUseSince = new Date().toISOString();
    await sendComposerMessage(
      appMate,
      `Load and use the shared Cloud skill named ${pluginWitness.skillName} from ${marketplace.name}, then follow its instructions exactly.`,
    );
    const skillCalls = await connector.toolCalls({
      name: "mock_echo",
      atLeast: 1,
      sinceIso: skillUseSince,
      timeoutMs: 300_000,
    });
    const skillServedTexts = skillCalls.map((call) => String(call.args.text ?? ""));
    const skillMarkerSeen = skillServedTexts.some((text) => text.includes(skillMarker));
    expect(skillMarkerSeen).toBe(true);
    const skillReply = await waitForAssistantReply(appMate, { timeoutMs: 300_000 });
    evidence.recordAssertionEvidence(
      "The shared skill made the teammate's agent use the organization connector",
      `Served mock_echo texts: ${JSON.stringify(skillServedTexts)}; assistant reply: ${skillReply.text.slice(0, 500)}.`,
      skillMarkerSeen,
    );

    // The connector witness can land while the skill turn is still narrating;
    // settle before taking the final teammate frame.
    await waitForButtonGone(appMate, "Stop", { timeoutMs: 240_000 });
    const shot = await screenshot(appMate);
    const seen = await validate(shot, [
      "The teammate's session shows a completed task that used the shared organization skill",
      "No 'Something went wrong', blank screen, or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
});
