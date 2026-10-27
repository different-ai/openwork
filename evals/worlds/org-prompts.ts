import { randomUUID } from "node:crypto";
import { browserScript } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";
import { isRecord, records } from "./library.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";

export const EVERYONE_PROMPT = "Write for non-technical readers. Never share customer names outside the organization.";
export const DESIGN_PROMPT = "Follow the brand guide in the Design folder and export images as PNG.";

/**
 * An organization Avery owns, Riley in the Design team, and a
 * prompt for everyone already saved. Avery is on the Design team's Prompts
 * tab, where Design has no prompt of its own yet.
 */
export async function orgPromptsTeamTab(seed: Seed) {
  const den = await seed.den({
    web: true,
    org: {
      name: `Prompts ${Date.now()}`,
      admin: { name: "Avery Owner" },
      members: { riley: { name: "Riley Designer" } },
    },
  });
  const riley = den.members.riley;
  if (!riley) throw new Error("seed.den() did not provision Riley's session");
  const organizationId = await seededOrganizationId(seed, den.admin);
  if (!organizationId) throw new Error("The seeded organization was not found.");
  const scope = { "x-openwork-org-id": organizationId };

  const org = await seed.api(riley, "/v1/org");
  const member = isRecord(org.body) && isRecord(org.body.currentMember) ? org.body.currentMember : null;
  if (!org.response.ok || typeof member?.id !== "string") throw new Error(`Reading Riley's membership failed: ${org.text.slice(0, 500)}`);
  const team = await seed.api(den.admin, "/v1/teams", { method: "POST", headers: scope, body: JSON.stringify({ name: "Design", memberIds: [member.id] }) });
  const teamId = isRecord(team.body) && isRecord(team.body.team) ? team.body.team.id : null;
  if (!team.response.ok || typeof teamId !== "string") throw new Error(`Creating Design failed: ${team.text.slice(0, 500)}`);

  const saved = await seed.api(den.admin, "/v1/org/prompts/everyone", { method: "PUT", headers: scope, body: JSON.stringify({ content: EVERYONE_PROMPT }) });
  if (!saved.response.ok) throw new Error(`Saving the prompt for everyone failed: HTTP ${saved.response.status} ${saved.text.slice(0, 500)}`);

  const viewport = { width: 1440, height: 1500 };
  const web = await seed.web({
    den, signedInAs: den.admin, headless: true, viewport,
    startPath: `/dashboard/members/teams/${encodeURIComponent(teamId)}?tab=prompts`,
  });

  return {
    den,
    teamId,
    web,
    everyoneUrl: new URL("/dashboard/members/teams/everyone?tab=prompts", den.ref.webUrl).toString(),
    /** The prompts Riley's desktop receives with its provider sync, in the order it appends them. */
    async rileyPrompts() {
      const read = await seed.api(riley, "/v1/me/prompts");
      if (!read.response.ok || !isRecord(read.body)) throw new Error(`Reading Riley's prompts failed: HTTP ${read.response.status}`);
      return records(read.body.prompts).map((entry) => ({ source: entry.source, teamName: entry.teamName ?? null, content: entry.content }));
    },
  };
}

export const REVISED_DESIGN_PROMPT = "Follow the brand guide in the Design folder and export images as SVG.";

/**
 * Riley, in the Design team, signed in to a real Den with
 * prompts saved for everyone and for Design, in the real app (in a browser)
 * on the OpenCode v2 engine. Turns go through OpenWork's server to the engine
 * as the app sends them; only the model is scripted. The model records
 * whether each request carried a watched line, without keeping the text.
 */
export async function orgPromptsDesktop(seed: Seed) {
  const mock = seed.mock({});
  const { den, webPort } = await denForAppWeb(seed, {
    org: { name: `Prompts desktop ${Date.now()}`, admin: { name: "Avery Owner" }, members: { riley: { name: "Riley Designer" } } },
    mocks: { agent: mock },
  });
  const model = den.mocks.agent;
  const riley = den.members.riley;
  if (!model || !riley) throw new Error("seed.den() did not provision the model or Riley's session");
  const organizationId = await seededOrganizationId(seed, den.admin);
  if (!organizationId) throw new Error("The seeded organization was not found.");
  const scope = { "x-openwork-org-id": organizationId };
  const org = await seed.api(riley, "/v1/org");
  const member = isRecord(org.body) && isRecord(org.body.currentMember) ? org.body.currentMember : null;
  if (!org.response.ok || typeof member?.id !== "string") throw new Error(`Reading Riley's membership failed: ${org.text.slice(0, 500)}`);
  const team = await seed.api(den.admin, "/v1/teams", { method: "POST", headers: scope, body: JSON.stringify({ name: "Design", memberIds: [member.id] }) });
  const teamId = isRecord(team.body) && isRecord(team.body.team) ? team.body.team.id : null;
  if (!team.response.ok || typeof teamId !== "string") throw new Error(`Creating Design failed: ${team.text.slice(0, 500)}`);
  async function savePrompt(path: string, content: string) {
    const saved = await seed.api(den.admin, path, { method: "PUT", headers: scope, body: JSON.stringify({ content }) });
    if (!saved.response.ok) throw new Error(`Saving ${path} failed: HTTP ${saved.response.status} ${saved.text.slice(0, 500)}`);
  }
  await savePrompt("/v1/org/prompts/everyone", EVERYONE_PROMPT);
  await savePrompt(`/v1/org/prompts/teams/${encodeURIComponent(teamId)}`, DESIGN_PROMPT);

  const token = randomUUID();
  const hostToken = randomUUID();
  const { app, workspace } = await signedInAppWeb(seed, {
    name: "org-prompts", den, webPort, as: "riley", headless: true,
    workspacePath: seed.tmpPath("org-prompts"), engine: "v2",
    env: { OPENWORK_TOKEN: token, OPENWORK_HOST_TOKEN: hostToken, OPENWORK_CLOUD_PROVIDER_SYNC_INTERVAL_MS: "600000" },
  });
  const mount = `/workspace/${workspace.workspaceId}`;
  /**
   * Calls Riley's local OpenWork server from inside the app's page, as the app
   * does, so it also works when the app runs in a Daytona sandbox.
   */
  async function request(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
    const result = await seed.evalIn(app, browserScript(async (path, method, bodyJson, token, hostToken) => {
      const port = localStorage.getItem("openwork.server.port");
      if (!port) return { status: 0, text: "missing local server port" };
      const response = await fetch("http://127.0.0.1:" + port + path, {
        method,
        headers: { Authorization: "Bearer " + token, "x-openwork-host-token": hostToken, "Content-Type": "application/json" },
        ...(bodyJson ? { body: bodyJson } : {}),
      });
      return { status: response.status, text: await response.text() };
    }, [path, init.method ?? "GET", init.body === undefined ? "" : JSON.stringify(init.body), token, hostToken]), { awaitPromise: true, timeoutMs: 120_000 });
    let body: unknown = result.text;
    try { body = result.text ? JSON.parse(result.text) : null; } catch { /* diagnostic text */ }
    return { status: result.status, body };
  }
  async function modelAdmin(path: string, body: unknown) {
    if (!model) throw new Error("Missing model");
    const response = await fetch(`${model.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error(`Model witness ${path} failed: ${response.status}`);
  }

  const providerId = "prompts-witness";
  const modelId = "prompts-model";
  const configured = await request(`${mount}/config`, { method: "PATCH", body: { opencode: { provider: { [providerId]: {
    npm: "@ai-sdk/openai-compatible", name: "Prompts witness",
    options: { baseURL: `${model.url}/v1`, apiKey: "sk-prompts-fixture" },
    models: { [modelId]: { name: "Prompts witness" } },
  } } } } });
  if (configured.status >= 300) throw new Error(`Configuring the witness model failed: ${configured.status}`);
  const reloaded = await request(`${mount}/engine/reload`, { method: "POST" });
  if (reloaded.status >= 300 && reloaded.status !== 503 && reloaded.status !== 504) throw new Error(`Reloading the engine failed: ${reloaded.status}`);
  // Same owned-runtime handoff as other app-in-a-browser worlds: renderer
  // sign-in alone does not establish the server's Den session the desktop
  // shell pushes (PUT /den-session), which provider sync runs on.
  const linked = await request("/den-session", { method: "PUT", body: { baseUrl: den.ref.apiUrl, token: riley.token, orgId: organizationId } });
  if (linked.status >= 300) throw new Error(`Den session handoff failed: HTTP ${linked.status}`);

  return {
    app, den, workspace,
    /** Runs one provider sync pass on Riley's OpenWork, as sign-in, focus and the interval do. */
    async sync() {
      const result = await request("/cloud-provider-sync/run", { method: "POST", body: { reason: "manual" } });
      return isRecord(result.body) ? result.body.status : result.status;
    },
    /**
     * Watch later model requests for one line of text. The engine escapes
     * the instructions inside the request, so watched text is a single line
     * with no characters that need escaping.
     */
    watchFor: (text: string) => modelAdmin("/admin/private-sentinels", { values: [text] }),
    /**
     * Riley sends one turn in a new conversation, through OpenWork's server
     * to the engine as the app does, and the model replies. Returns whether
     * the model's request carried the watched line.
     */
    async turnSawWatched(prompt: string) {
      const reply = `Done: ${prompt}`;
      await modelAdmin("/admin/agent-workloads", { workloads: [{ promptMarker: prompt, latestUserTurn: true, finalReply: reply, steps: [] }] });
      const session = await seed.session(app, { title: prompt.slice(0, 40) });
      const native = `${mount}/opencode2/api/session/${session.sessionId}`;
      const selected = await request(`${native}/model`, { method: "POST", body: { model: { providerID: providerId, id: modelId } } });
      if (selected.status >= 300) throw new Error(`Selecting the witness model failed: ${selected.status} ${JSON.stringify(selected.body)}`);
      const sent = await request(`${native}/prompt`, { method: "POST", body: { text: prompt } });
      if (sent.status >= 300) throw new Error(`Sending the turn failed: ${sent.status} ${JSON.stringify(sent.body)}`);
      for (const deadline = Date.now() + 120_000; Date.now() < deadline;) {
        const stored = await request(`${native}/message`);
        const messages = isRecord(stored.body) && Array.isArray(stored.body.data) ? stored.body.data : [];
        if (JSON.stringify(messages).includes(reply)) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      const requests = await model.agentRequests({ promptMarker: prompt, atLeast: 1, timeoutMs: 30_000 });
      if (requests.length === 0) throw new Error(`The model never received the turn ${JSON.stringify(prompt)}`);
      return requests.some((entry) => entry.privateSentinelSeen === true);
    },
    reviseDesignPrompt: () => savePrompt(`/v1/org/prompts/teams/${encodeURIComponent(teamId)}`, REVISED_DESIGN_PROMPT),
    async removePrompts() {
      for (const path of ["/v1/org/prompts/everyone", `/v1/org/prompts/teams/${encodeURIComponent(teamId)}`]) {
        const result = await seed.api(den.admin, path, { method: "DELETE", headers: scope });
        if (!result.response.ok) throw new Error(`Removing ${path} failed: HTTP ${result.response.status}`);
      }
    },
  };
}
