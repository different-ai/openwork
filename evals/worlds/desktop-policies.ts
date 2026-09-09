import { faultProxy, mcpMock } from "@openwork/env";
import type { Seed } from "@openwork/env";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { isRecord, records } from "./library.ts";
import { bootServer, stopChild } from "./openwork-server-cli.ts";

/**
 * The organization's default desktop policy as Den returns it, with the shape
 * checks a spec needs before comparing saved values.
 */
export async function readDefaultDesktopPolicy(
  channel: Pick<Seed, "api">,
  admin: Parameters<Seed["api"]>[0],
): Promise<Record<string, unknown>> {
  const result = await channel.api(admin, "/v1/desktop-policies");
  const policies = isRecord(result.body) ? records(result.body.desktopPolicies) : [];
  const policy = policies.find((entry) => entry.isDefault === true);
  if (!result.response.ok || !policy || typeof policy.id !== "string") {
    throw new Error(`Reading the default desktop policy failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return policy;
}

/**
 * One organization whose default desktop policy is still Custom, a member
 * signed in to a fresh desktop, and the admin signed in to that policy's Den
 * Web editor. Only Den and the member desktop are placed; the admin browser
 * shares the Den's placement so Den Web is reached over loopback.
 */
export async function defaultPolicyEditorAndMemberDesktop(seed: Seed) {
  const stamp = Date.now();
  const den = await seed.den({
    org: {
      name: `Restricted Policy ${stamp}`,
      admin: { name: "Sarah" },
      members: { jordan: { name: "Jordan Eval" } },
    },
  });
  if (!den.members.jordan) throw new Error("seed.den() did not provision the jordan member session");

  const policyBefore = await readDefaultDesktopPolicy(seed, den.admin);
  const policyId = String(policyBefore.id);
  const editorPath = `/dashboard/desktop-policies/${encodeURIComponent(policyId)}`;

  const member = await seed.desktop({ den, as: "jordan" });
  const admin = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: editorPath,
    headless: true,
    // Tall enough that the whole capability list, through the editable
    // Welcome Page row, stays inside the frame the vision judge sees.
    viewport: { width: 1440, height: 2100 },
  });

  return { den, member, admin, policyId, editorPath };
}

/** Two ordinary members share defaults that block Alpha updates. Jordan gets
 * Alpha access only from the overlapping grant team and belongs to both the
 * focused team and an overlapping grant team; Casey is the unaffected control.
 * The admin starts at Team Access and Jordan starts in a real desktop. */
export async function teamAccess(seed: Seed) {
  const nonce = `team-policy-${Date.now()}`;
  const shellTool = process.env.OPENWORK_EVAL_ENGINE === "v2" ? "shell" : "bash";
  const commandProofs = ["restricted", "control"].map((member) => ({
    marker: `${nonce}-${member}`, file: `${nonce}-${member}.txt`, reply: `${nonce}-${member}-finished`,
    command: `printf '${nonce}' > '${nonce}-${member}.txt'`,
  }));
  const den = await seed.den({
    mocks: { witness: mcpMock({ allowUnauthenticatedMcp: true, agentWorkloads: commandProofs.map((proof) => ({
      promptMarker: proof.marker, finalReply: proof.reply, steps: [{ tool: shellTool, allowUnadvertisedTool: true, arguments: { command: proof.command, description: "Write a policy test witness" } }],
    })) }) },
    org: {
      name: `Team Access ${Date.now()}`,
      admin: { name: "Sarah" },
      members: { jordan: { name: "Jordan Eval" }, casey: { name: "Casey Eval" } },
    },
  });
  if (!den.members.jordan || !den.members.casey) throw new Error("Missing ordinary member sessions");
  // Publish a deterministic catalog before desktop boot, as in the cloud
  // provider sync world. An empty organization leaves the launch model
  // unavailable and legitimately opens model recovery when Custom restores
  // provider access. This journey exercises permissions, not inference.
  const provider = await seed.api(den.admin, "/v1/llm-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Team access model",
      source: "custom",
      customConfig: {
        id: "team-access-eval-provider",
        name: "Team access model",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${den.mocks.witness.url}/v1` },
        env: ["TEAM_ACCESS_EVAL_PROVIDER_API_KEY"],
        models: [{ id: "mock-agent-workload-model", name: "Team access model", tool_call: true }],
      },
      apiKey: "sk-openwork-team-access-eval-only",
      allMembers: true,
      memberIds: [],
      teamIds: [],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const llmProvider = isRecord(provider.body) && isRecord(provider.body.llmProvider) ? provider.body.llmProvider : null;
  if (provider.response.status !== 201 || typeof llmProvider?.id !== "string") {
    throw new Error(`Organization model setup failed: HTTP ${provider.response.status}`);
  }
  for (const account of [den.members.jordan, den.members.casey]) {
  const connected = await seed.api(account, `/v1/llm-providers/${encodeURIComponent(llmProvider.id)}/connect`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (connected.response.status !== 200) throw new Error(`Member model entitlement setup failed: HTTP ${connected.response.status}`);
  }
  const flags = {
    allowCustomProviders: true, allowZenModel: true, allowMultipleWorkspaces: true,
    allowControlSettings: true, allowManageExtensions: true, allowBuiltInExtensions: true,
    allowAlphaUpdates: true, showWelcomePage: true,
  };
  const initial = await readDefaultDesktopPolicy(seed, den.admin);
  const reset = await seed.api(den.admin, `/v1/desktop-policies/${initial.id}`, {
    method: "PATCH", body: JSON.stringify({ policyName: "Default desktop policy", policy: { ...flags, allowAlphaUpdates: false } }),
  });
  if (!reset.response.ok) throw new Error(`Default grants failed: ${reset.text}`);
  const org = await seed.api(den.members.jordan, "/v1/org");
  const currentMember = isRecord(org.body) && isRecord(org.body.currentMember) ? org.body.currentMember : null;
  if (!org.response.ok || typeof currentMember?.id !== "string") throw new Error("Missing target member ID");
  const controlOrg = await seed.api(den.members.casey, "/v1/org");
  const controlMember = isRecord(controlOrg.body) && isRecord(controlOrg.body.currentMember) ? controlOrg.body.currentMember : null;
  if (!controlOrg.response.ok || typeof controlMember?.id !== "string") throw new Error("Missing control member ID");
  async function createTeam(name: string, memberId: string) {
    const result = await seed.api(den.admin, "/v1/teams", {
      method: "POST", body: JSON.stringify({ name, memberIds: [memberId] }),
    });
    const team = isRecord(result.body) && isRecord(result.body.team) ? result.body.team : null;
    if (!result.response.ok || typeof team?.id !== "string") throw new Error(`Team setup failed: ${result.text}`);
    return team.id;
  }
  const teamId = await createTeam("Focused work", currentMember.id);
  const grantTeamId = await createTeam("Additional tools", currentMember.id);
  const controlTeamId = await createTeam("Everyday work", controlMember.id);
  const grant = await seed.api(den.admin, "/v1/desktop-policies", {
    method: "POST", body: JSON.stringify({ policyName: "Additional team grants", policy: flags, teamIds: [grantTeamId] }),
  });
  if (!grant.response.ok) throw new Error(`Overlapping grant failed: ${grant.text}`);
  const pluginName = "Approved briefing";
  const rawSourceText = "---\nname: approved-briefing\ndescription: An approved team briefing skill.\n---\nSummarize the supplied notes into decisions and next steps. Team access proof.";
  const plugin = await seed.api(den.admin, "/v1/plugins", {
    method: "POST", body: JSON.stringify({ name: pluginName, components: [{ type: "skill", input: { rawSourceText } }] }),
  });
  const item = isRecord(plugin.body) && isRecord(plugin.body.item) ? plugin.body.item : null;
  if (!plugin.response.ok || typeof item?.id !== "string") throw new Error(`Approved skill setup failed: ${plugin.text}`);
  const pluginId = item.id;
  const shared = await seed.api(den.admin, `/v1/plugins/${pluginId}/access`, {
    method: "POST", body: JSON.stringify({ teamId, role: "viewer" }),
  });
  if (!shared.response.ok) throw new Error(`Approved skill sharing failed: ${shared.text}`);
  const editorPath = `/dashboard/members/teams/${teamId}`;
  const member = await seed.desktop({ den, as: "jordan", model: `${llmProvider.id}/mock-agent-workload-model` });
  const control = await seed.desktop({ den, as: "casey", model: `${llmProvider.id}/mock-agent-workload-model` });
  const admin = await seed.web({ den, signedInAs: den.admin, startPath: editorPath, headless: true, viewport: { width: 1440, height: 2100 } });
  return { den, member, control, admin, commandProofs, nonce, providerId: llmProvider.id, teamId, grantTeamId, controlTeamId,
    memberId: currentMember.id, controlMemberId: controlMember.id, editorPath, pluginId, pluginName, rawSourceText };
}

/** A real OpenWork server signed in to Den through a fault proxy, without an
 * Electron renderer. The journey can therefore count only policy verification
 * requests caused by each evaluation. */
export async function managedPolicyRecovery(seed: Seed) {
  const den = await seed.den({
    mocks: { witness: mcpMock({ allowUnauthenticatedMcp: true }) },
    org: {
      name: `Managed policy recovery ${Date.now()}`,
      admin: { name: "Policy Recovery Admin" },
      members: { member: { name: "Policy Recovery Member" } },
    },
  });
  const member = den.members.member;
  if (!member) throw new Error("Missing policy recovery member session");
  const org = await seed.api(member, "/v1/org");
  const organization = isRecord(org.body) && isRecord(org.body.organization) ? org.body.organization : null;
  const currentMember = isRecord(org.body) && isRecord(org.body.currentMember) ? org.body.currentMember : null;
  if (!org.response.ok || typeof organization?.id !== "string" || typeof currentMember?.id !== "string") {
    throw new Error("Missing policy recovery organization or member ID");
  }

  const modelId = "assigned-policy-retry-proof";
  const created = await seed.api(den.admin, "/v1/llm-providers", {
    method: "POST",
    body: JSON.stringify({
      name: "Assigned policy recovery model",
      source: "custom",
      customConfig: {
        id: "assigned-policy-recovery-provider",
        name: "Assigned policy recovery model",
        npm: "@ai-sdk/openai-compatible",
        options: { baseURL: `${den.mocks.witness.url}/v1` },
        env: ["ASSIGNED_POLICY_RECOVERY_API_KEY"],
        models: [{ id: modelId, name: "Assigned policy recovery model" }],
      },
      apiKey: "sk-openwork-assigned-policy-recovery-eval-only",
      allMembers: false,
      memberIds: [currentMember.id],
      teamIds: [],
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const llmProvider = isRecord(created.body) && isRecord(created.body.llmProvider) ? created.body.llmProvider : null;
  if (created.response.status !== 201 || typeof llmProvider?.id !== "string" || !/^lpr_/.test(llmProvider.id)) {
    throw new Error(`Assigned organization model setup failed: HTTP ${created.response.status}`);
  }
  const providerId = llmProvider.id;
  const manageable = await seed.api(den.admin, "/v1/llm-providers?scope=manageable", { signal: AbortSignal.timeout(30_000) });
  const providers = isRecord(manageable.body) && Array.isArray(manageable.body.llmProviders)
    ? manageable.body.llmProviders.filter(isRecord)
    : [];
  const provider = providers.find((entry) => entry.id === providerId);
  const access = provider && isRecord(provider.access) ? provider.access : null;
  const memberAccess = access && Array.isArray(access.members)
    ? access.members.filter(isRecord).find((entry) => entry.orgMembershipId === currentMember.id)
    : null;
  if (!manageable.response.ok || typeof memberAccess?.id !== "string") {
    throw new Error(`Assigned organization model access lookup failed: HTTP ${manageable.response.status}`);
  }
  const accessId = memberAccess.id;

  const stored = await readDefaultDesktopPolicy(seed, den.admin);
  if (!isRecord(stored.policy) || typeof stored.id !== "string" || typeof stored.policyName !== "string") {
    throw new Error("Missing default policy for recovery proof");
  }
  const allowedPolicy = { ...stored.policy, allowCustomProviders: false, allowZenModel: true };
  const updateBuiltInModel = async (allowed: boolean) => seed.api(den.admin, `/v1/desktop-policies/${stored.id}`, {
    method: "PATCH",
    body: JSON.stringify({ policyName: stored.policyName, policy: { ...allowedPolicy, allowZenModel: allowed } }),
  });
  const allowed = await updateBuiltInModel(true);
  if (!allowed.response.ok) throw new Error(`Allowing the built-in model failed: HTTP ${allowed.response.status}`);

  const root = seed.tmpPath("managed-policy-recovery");
  const workspace = join(root, "workspace");
  const home = join(root, "home");
  await mkdir(workspace, { recursive: true });
  await mkdir(home, { recursive: true });
  // The OpenWork server below runs beside Vitest, so its Den fault boundary
  // must run there too even when Den is on Daytona. Point it at the API origin
  // directly: unlike browser traffic, server verification has no web Origin.
  const proxy = await faultProxy({ ...den.ref, webUrl: den.ref.apiUrl });
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("OPENWORK_") && !key.startsWith("OPENCODE")));
  const token = "owt_managed_policy_recovery";
  const booted = bootServer({
    ...inherited,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_CACHE_HOME: join(home, ".cache"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS: "3600000",
    OPENWORK_MANAGE_OPENCODE: "0",
  }, token, workspace, () => {});
  try {
    const baseUrl = await booted.listening;
    const request = async (path: string, input: { method?: string; host?: boolean; body?: unknown } = {}) => {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (input.host) headers["x-openwork-host-token"] = `${token}-host`;
      else headers.authorization = `Bearer ${token}`;
      const response = await fetch(`${baseUrl}${path}`, {
        method: input.method ?? "GET",
        headers,
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      let body: unknown = null;
      try { body = text ? JSON.parse(text) : null; }
      catch { body = text; }
      return { status: response.status, body };
    };
    const session = await request("/den-session", {
      method: "PUT",
      host: true,
      body: { baseUrl: proxy.ref.webUrl, token: member.token, orgId: organization.id },
    });
    if (session.status !== 204) throw new Error(`Setting the policy recovery Den session failed: HTTP ${session.status} ${JSON.stringify(session.body)}`);
    const readProviderState = async () => {
      const runtime = await request("/runtime-config/providers", { host: true });
      const status = await request("/cloud-provider-sync/status");
      return { runtime, status };
    };
    const syncProviders = async () => {
      const run = await request("/cloud-provider-sync/run", { method: "POST", host: true, body: { reason: "managed-policy-recovery" } });
      const { runtime, status } = await readProviderState();
      return { run, runtime, status };
    };
    const memberCatalog = async () => {
      const result = await seed.api(member, "/v1/llm-providers", { signal: AbortSignal.timeout(30_000) });
      const items = isRecord(result.body) && Array.isArray(result.body.llmProviders)
        ? result.body.llmProviders.filter(isRecord)
        : [];
      return { status: result.response.status, providers: items };
    };
    const revokeProviderAccess = async () => {
      const result = await seed.api(den.admin, `/v1/llm-providers/${encodeURIComponent(providerId)}/access/${encodeURIComponent(accessId)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(30_000),
      });
      return result.response.status;
    };
    let disposed = false;
    return {
      den,
      proxy,
      providerId,
      modelId,
      memberCatalog,
      readProviderState,
      revokeProviderAccess,
      syncProviders,
      updateBuiltInModel,
      evaluate: (body: Record<string, unknown>) => request("/managed-policy/evaluate", { method: "POST", body }),
      async [Symbol.asyncDispose]() {
        if (disposed) return;
        disposed = true;
        await stopChild(booted.child);
        await proxy[Symbol.asyncDispose]();
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await stopChild(booted.child);
    await proxy[Symbol.asyncDispose]();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}
