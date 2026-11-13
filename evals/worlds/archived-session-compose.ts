import { randomUUID } from "node:crypto";
import { browserScript, reload } from "@openwork/cdp";
import { eventually, type Seed } from "@openwork/env";
import { configureProvider } from "./chat.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dataOf(value: unknown): unknown {
  return isRecord(value) && "data" in value ? value.data : value;
}

async function archivedConversation(seed: Seed, enabled: boolean) {
  const adminEmail = "archive-rollout-admin@example.test";
  const { den, webPort } = await denForAppWeb(seed, {
    // A prepared Den's platform allowlist belongs to its bootstrap identity,
    // not a newly seeded org admin. Own the Den and name that identity explicitly.
    env: { DEN_BOOTSTRAP_ADMIN_EMAILS: adminEmail },
    org: {
      name: "Archive review fixture",
      admin: { name: "Rollout operator", email: adminEmail },
      members: { member: { name: "Review member", email: "archive-review-member@example.test" } },
    },
  });
  if (enabled) await enableOrganizationCapabilities(seed, den.admin, { archivedSessionCompose: true });
  const original = { prompt: "Summarize the earlier review notes.", reply: "The earlier review is complete." };
  const followup = { prompt: "Add a short next-step checklist to these review notes.", reply: "The next-step checklist is ready." };
  const token = randomUUID();
  const { app, workspace } = await signedInAppWeb(seed, {
    name: enabled ? "archived-session-compose" : "archived-session-compose-off",
    den, webPort, as: "member", engine: "v2", workspacePath: seed.tmpPath("archived-session-compose"),
    env: { OPENWORK_TOKEN: token },
    mocks: { agent: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [original, followup].map(turn => ({
      promptMarker: turn.prompt, latestUserTurn: true, finalReply: turn.reply, steps: [],
    })) }) },
  });
  const mock = app.mocks.agent;
  if (!mock) throw new Error("The archived-conversation model witness did not start");
  const providerId = "archive-review";
  const modelId = "review";
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    enabled_providers: [providerId], model: `${providerId}/${modelId}`, small_model: `${providerId}/${modelId}`,
    provider: { [providerId]: {
      name: "Review fixture", npm: "@ai-sdk/openai-compatible",
      options: { baseURL: `${mock.url}/v1`, apiKey: "synthetic-archive-review-key" },
      whitelist: [modelId], models: { [modelId]: {
        name: "Review fixture model", tool_call: true, limit: { context: 128000, output: 8192 },
        provider: { npm: "@ai-sdk/openai-compatible", api: `${mock.url}/v1` },
      } },
    } },
  }, "v2");

  // There is no first-class seed primitive for native transcript/archive or
  // group arrangement. These are the public HTTP routes used by the app, not
  // renderer stores or test-only controls; all writes finish before any act.
  async function request(path: string, method = "GET", body: unknown = null): Promise<unknown> {
    const result = await seed.evalIn(app, browserScript(async (base, path, token, method, body) => {
      const response = await fetch(base + path, {
        method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === null ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    }, [app.openworkUrl, path, token, method, body]), { awaitPromise: true, timeoutMs: 35_000 });
    if (!isRecord(result) || typeof result.status !== "number" || result.status < 200 || result.status >= 300) {
      throw new Error(`Archived-conversation fixture failed: ${method} ${path} (HTTP ${isRecord(result) ? result.status : "unknown"})`);
    }
    return result.body;
  }

  const active = await seed.session(app, { title: "Keep these reference notes active" });
  const otherArchived = await seed.session(app, { title: "Keep this separate review archived" });
  const session = await seed.session(app, { title: "Continue the archived review" });
  const mount = `/workspace/${encodeURIComponent(workspace.workspaceId)}`;
  const sessionsPath = `${mount}/opencode2/api/session`;
  const sessionPath = `${sessionsPath}/${encodeURIComponent(session.sessionId)}`;
  const groupsPath = `${mount}/session-groups`;
  const group = { id: "review-queue", label: "Review queue" };
  await request(groupsPath, "POST", group);
  for (const item of [session, active]) {
    await request(`${groupsPath}/assignments/${encodeURIComponent(item.sessionId)}`, "PATCH", { groupId: group.id });
  }
  await request(`${sessionPath}/model`, "POST", { model: { providerID: providerId, id: modelId } });
  await request(`${sessionPath}/prompt`, "POST", { text: original.prompt, delivery: "steer" });
  await eventually(async () => {
    const body = dataOf(await request(`${sessionPath}/message?limit=100`));
    const messages = Array.isArray(body) ? body : isRecord(body) && Array.isArray(body.items) ? body.items : [];
    return messages.some(message => isRecord(message) && message.type === "assistant" && message.finish === "stop"
      && JSON.stringify(message).includes(original.reply));
  }, { within: 90_000, intervalMs: 250, label: "the earlier review finishes before it is archived", until: Boolean });
  await request(sessionPath, "PATCH", { archived: true });
  await request(`${sessionsPath}/${encodeURIComponent(otherArchived.sessionId)}`, "PATCH", { archived: true });
  const initial = {
    messages: await request(`${sessionPath}/message?limit=100`),
    sessions: await request(`${sessionsPath}?limit=200`),
    groups: await request(groupsPath),
    active: await request(`${sessionsPath}/${encodeURIComponent(active.sessionId)}`),
    activeMessages: await request(`${sessionsPath}/${encodeURIComponent(active.sessionId)}/message?limit=100`),
    otherArchived: await request(`${sessionsPath}/${encodeURIComponent(otherArchived.sessionId)}`),
    otherArchivedMessages: await request(`${sessionsPath}/${encodeURIComponent(otherArchived.sessionId)}/message?limit=100`),
    requests: await mock.agentRequests(),
  };
  await reload(app);
  return {
    app, den, member: den.members.member, workspace, session, active, otherArchived, group, original, followup,
    enabled, initial, sessionsPath, sessionPath, groupsPath,
    // go() takes an app route and waits for the mounted router after reload;
    // do not start a second document navigation while the entry graph is loading.
    route: `/workspace/${encodeURIComponent(workspace.workspaceId)}/session/${encodeURIComponent(session.sessionId)}`,
    // Read-only model HTTP witness; never prepares a new turn during an act.
    requests: () => mock.agentRequests(),
  };
}

export function archivedSessionCompose(seed: Seed) {
  return archivedConversation(seed, true);
}

export function archivedSessionComposeOff(seed: Seed) {
  return archivedConversation(seed, false);
}
