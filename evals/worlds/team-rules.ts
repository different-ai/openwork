import { allocateFreePorts } from "@openwork/cdp";
import { engineSessionProbe } from "@openwork/behaviors";
import { startBrowserFixture, type Place, type Seed } from "@openwork/env";
import type { MockAgentToolStep } from "@openwork/labs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configureProvider } from "./chat.ts";
import { enableOrganizationCapabilities } from "./dashboards.ts";
import { isRecord, records } from "./library.ts";

/** OpenCode permission rules, as the Permissions screens save them. */
export type TeamRule = { action: "shell" | "webfetch" | "skill" | "mcp"; resource: string; effect: "allow" | "deny" };

/**
 * An organization with Permissions on and two ordinary members: Riley is in
 * the Contractors team, which has its own permission set; Morgan is in no team
 * and is the unaffected control. Permission rules start off for the
 * organization, as on a fresh deployment.
 */
export function teamRules(seed: Seed) {
  return teamRulesOrganization(seed, { web: false });
}

/** The same organization with permission rules on and the owner on the Contractors team's permissions page. */
export async function teamRulesEditor(seed: Seed) {
  const world = await teamRulesOrganization(seed, { web: true });
  await world.enableTeamRules();
  const web = await seed.web({
    den: world.den,
    signedInAs: world.den.admin,
    startPath: `/dashboard/permissions/${encodeURIComponent(world.contractorsSetId)}`,
    headless: true,
    viewport: { width: 1280, height: 1400 },
  });
  return { ...world, web };
}

/**
 * Riley's Contractors rules allow only `echo` commands and no local skills or
 * MCP servers. Riley and Morgan each chat in OpenWork Web on the v2 engine,
 * signed in to Den, in a folder with a local skill and a local MCP server, with
 * a model that asks to save a note with `printf` or to load the skill.
 */
export async function teamRulesChat(seed: Seed) {
  const webPorts = await allocateFreePorts(2);
  const world = await teamRulesOrganization(seed, { web: true, trustedOrigins: webPorts.map((port) => `http://127.0.0.1:${port}`) });
  await world.enableTeamRules();
  await world.saveTeamRules([
    { action: "shell", resource: "*", effect: "deny" },
    { action: "shell", resource: "echo *", effect: "allow" },
    { action: "skill", resource: "*", effect: "deny" },
    { action: "mcp", resource: "*", effect: "deny" },
  ]);
  const riley = await memberEngineChat(seed, world, "riley", webPorts[0]);
  const morgan = await memberEngineChat(seed, world, "morgan", webPorts[1]);
  // Send only once each engine has settled its plugins for the member's policy.
  await riley.teamRulesPlugin({ until: (plugin) => plugin?.state === "active" });
  await morgan.teamRulesPlugin({ until: (plugin) => plugin === null });
  return { ...world, riley, morgan };
}

/**
 * Riley's Contractors rules allow only the project briefing page. Riley works
 * in the desktop app, signed in to Den, with a model that asks the built-in
 * browser to open pages; a local page fixture records every page request.
 */
export async function teamWebsiteRulesBrowser(seed: Seed, { place }: { place: Place }) {
  const stack = new AsyncDisposableStack();
  try {
    const world = await teamRulesOrganization(seed, { web: false });
    await world.enableTeamRules();
    await world.saveTeamRules([
      { action: "webfetch", resource: "*", effect: "deny" },
      { action: "webfetch", resource: "http://127.0.0.1:*/briefing", effect: "allow" },
    ]);
    const mock = (await seed.mock({ isolatedProcessEnv: true }).boot(place)).handle;
    stack.defer(() => mock.stop());
    const created = await seed.api(world.den.admin, "/v1/llm-providers", {
      method: "POST",
      body: JSON.stringify({
        name: "Team rules browser model", source: "custom", allMembers: true, memberIds: [], teamIds: [],
        apiKey: "sk-openwork-team-rules-eval-only",
        customConfig: {
          id: "team-rules-browser-provider", name: "Team rules browser model", npm: "@ai-sdk/openai-compatible",
          options: { baseURL: `${mock.url}/v1` }, env: ["TEAM_RULES_BROWSER_API_KEY"],
          models: [{ id: "team-rules-browser-model", name: "Team rules browser model", tool_call: true }],
        },
      }),
    });
    const provider = isRecord(created.body) && isRecord(created.body.llmProvider) ? created.body.llmProvider : null;
    if (created.response.status !== 201 || typeof provider?.id !== "string") throw new Error(`Organization model setup failed: HTTP ${created.response.status}`);
    const riley = world.den.members.riley;
    if (!riley) throw new Error("Missing Riley's session");
    const connected = await seed.api(riley, `/v1/llm-providers/${encodeURIComponent(provider.id)}/connect`);
    if (!connected.response.ok) throw new Error(`Member model entitlement setup failed: HTTP ${connected.response.status}`);
    const app = await seed.desktop({ name: "team-website-rules", den: world.den, as: "riley", model: `${provider.id}/team-rules-browser-model` });
    const workspacePath = seed.tmpPath("team-website-rules");
    await mkdir(workspacePath, { recursive: true });
    const workspace = await seed.workspace(app, workspacePath, { create: true });
    const session = await seed.session(app, { title: "Project research" });
    const fixture = stack.use(await startBrowserFixture(app, { requireSignIn: false }));
    return {
      ...world, app, workspace, session, pageOrigin: fixture.origin,
      async prepareTurn(promptMarker: string, finalReply: string, steps: MockAgentToolStep[]) {
        const response = await fetch(`${mock.url}/admin/agent-workloads`, { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workloads: [{ promptMarker, latestUserTurn: true, finalReply, steps }] }) });
        if (!response.ok) throw new Error("The browser model workload could not be configured");
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}

type TeamRulesOrganization = Awaited<ReturnType<typeof teamRulesOrganization>>;

async function memberEngineChat(seed: Seed, world: TeamRulesOrganization, member: "riley" | "morgan", webPort: number | undefined) {
  const signedIn = world.den.members[member];
  if (!signedIn || !webPort) throw new Error(`Missing ${member}'s session or web port`);
  const marker = `TEAM_RULES_NOTE_${member.toUpperCase()}`;
  const skillMarker = `TEAM_RULES_SKILL_${member.toUpperCase()}`;
  const workspacePath = seed.tmpPath(`team-rules-${member}`);
  await mkdir(join(workspacePath, ".opencode", "skills", "team-notes"), { recursive: true });
  await writeFile(join(workspacePath, ".opencode", "skills", "team-notes", "SKILL.md"),
    "---\nname: team-notes\ndescription: How this team writes meeting notes.\n---\nWrite decisions first, then owners.\n");
  // A local MCP server from the folder's own config file, outside OpenWork's settings.
  await writeFile(join(workspacePath, "opencode.json"), JSON.stringify({ mcp: { "notes-server": { type: "remote", url: "http://127.0.0.1:9/mcp" } } }));
  const note = "team-rule-note.txt";
  const command = `printf '%s' 'saved by the agent' > '${note}'`;
  const app = await seed.appWeb({
    name: `team-rules-${member}`, workspacePath, webPort, headless: true, engine: "v2", den: world.den.ref,
    mocks: { witness: seed.mock({ isolatedProcessEnv: true, agentWorkloads: [{
      promptMarker: marker, finalReply: "I tried to save the note.",
      steps: [{ tool: "shell", arguments: { command, description: "Save a note" } }],
    }, {
      promptMarker: skillMarker, finalReply: "I tried the team notes skill.",
      steps: [{ tool: "skill", arguments: { id: "team-notes" } }],
    }] }) },
  });
  await seed.signIn(app, signedIn, member);
  const workspace = await seed.workspace(app, workspacePath);
  const witness = app.mocks.witness;
  if (!witness) throw new Error("Missing the witness model");
  await configureProvider(seed, app, workspace.workspaceId, "team-rules-witness", "team-rules-model", {
    provider: { "team-rules-witness": {
      npm: "@ai-sdk/openai-compatible", name: "Team rules witness",
      options: { baseURL: `${witness.url}/v1`, apiKey: "fixture-only" },
      models: { "team-rules-model": { name: "Team rules model", tool_call: true } },
    } },
  }, "v2");
  const chat = await seed.session(app, { title: "Save a note" });
  // The world reads engine state with the isolated app's own server token.
  const token = await seed.evalIn(app, () => localStorage.getItem("openwork.server.token"));
  if (typeof token !== "string" || !token) throw new Error("Missing isolated app-web token");
  const native = engineSessionProbe({ engine: "v2", serverUrl: app.openworkUrl, token, workspaceId: workspace.workspaceId });
  const server = (path: string, init: RequestInit = {}) => fetch(`${app.openworkUrl}/workspace/${encodeURIComponent(workspace.workspaceId)}${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000),
  });
  const settled = async (tool: string) => {
    const snapshot = await native.snapshot(chat.sessionId);
    if (!snapshot.ok || !snapshot.data) return null;
    return snapshot.data.messages.flatMap((message) => message.parts).find((part) => part.tool === tool && ["completed", "error"].includes(part.status)) ?? null;
  };
  const pluginState = async () => {
    const response = await server("/opencode2/api/plugin");
    if (!response.ok) throw new Error(`Listing engine plugins failed: HTTP ${response.status}`);
    const plugin = records(await response.json()).find((entry) => entry.id === "openwork.policies");
    const state = isRecord(plugin?.state) && typeof plugin.state.status === "string" ? plugin.state.status : "unknown";
    return plugin ? { state, error: isRecord(plugin.state) && typeof plugin.state.error === "string" ? plugin.state.error : null } : null;
  };
  return {
    app, command,
    prompt: `Save a short note in this folder with a shell command. ${marker}`,
    skillPrompt: `Use the team notes skill for this meeting. ${skillMarker}`,
    /** The engine's own record of the shell call, once it has settled. */
    shellCall: () => settled("shell"),
    skillCall: () => settled("skill"),
    /** The folder's local MCP server as the engine reports it: its status, or null when absent. */
    async notesServerStatus() {
      const response = await server("/opencode2/api/mcp");
      if (!response.ok) throw new Error(`Listing engine MCP servers failed: HTTP ${response.status}`);
      const body: unknown = await response.json();
      const entries = isRecord(body) && Array.isArray(body.data) ? records(body.data) : records(body);
      const entry = entries.find((candidate) => candidate.name === "notes-server");
      return entry ? (isRecord(entry.status) && typeof entry.status.status === "string" ? entry.status.status : "unknown") : null;
    },
    /** Adding a local MCP server through OpenWork, as the Library's Add MCP form does. */
    async addLocalMcp(name: string) {
      const response = await server("/mcp", { method: "POST", body: JSON.stringify({ name, config: { type: "remote", url: "http://127.0.0.1:9/mcp" } }) });
      const body: unknown = await response.json().catch(() => null);
      return { status: response.status, message: isRecord(body) && typeof body.message === "string" ? body.message : "" };
    },
    wroteNote: () => access(join(workspacePath, note)).then(() => true, () => false),
    /** The OpenWork policies plugin as the engine reports it, waiting up to a minute for `until`. */
    async teamRulesPlugin({ until }: { until: (plugin: Awaited<ReturnType<typeof pluginState>>) => boolean }) {
      const deadline = Date.now() + 60_000;
      for (;;) {
        const plugin = await pluginState();
        if (until(plugin) || Date.now() > deadline) return plugin;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    },
  };
}

async function teamRulesOrganization(seed: Seed, { web, trustedOrigins }: { web: boolean; trustedOrigins?: string[] }) {
  const stamp = Date.now().toString(36);
  const den = await seed.den({
    web,
    schema: "migrate",
    env: { DEN_PLAN_GATING_ENABLED: "false", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "" },
    ...(trustedOrigins ? { trustedOrigins } : {}),
    org: {
      name: `Team Rules ${stamp}`,
      admin: { name: "Avery Owner" },
      members: { riley: { name: "Riley Contractor" }, morgan: { name: "Morgan Staff" } },
    },
  });
  const riley = den.members.riley;
  const morgan = den.members.morgan;
  if (!riley || !morgan) throw new Error("seed.den() did not provision the member sessions");

  const org = await seed.api(riley, "/v1/org");
  const rileyMember = isRecord(org.body) && isRecord(org.body.currentMember) ? org.body.currentMember : null;
  if (!org.response.ok || typeof rileyMember?.id !== "string") throw new Error(`Reading Riley's membership failed: ${org.text.slice(0, 500)}`);
  const team = await seed.api(den.admin, "/v1/teams", { method: "POST", body: JSON.stringify({ name: "Contractors", memberIds: [rileyMember.id] }) });
  const teamId = isRecord(team.body) && isRecord(team.body.team) ? team.body.team.id : null;
  if (!team.response.ok || typeof teamId !== "string") throw new Error(`Team setup failed: ${team.text.slice(0, 500)}`);

  await enableOrganizationCapabilities(seed, den.admin, { permissions: true });
  const created = await seed.api(den.admin, "/v1/permissions/sets", { method: "POST", body: JSON.stringify({ teamId, permissions: [] }) });
  const contractorsSetId = isRecord(created.body) && isRecord(created.body.set) ? created.body.set.id : null;
  if (!created.response.ok || typeof contractorsSetId !== "string") throw new Error(`Team permissions setup failed: HTTP ${created.response.status} ${created.text.slice(0, 500)}`);
  const sets = await seed.api(den.admin, "/v1/permissions/sets");
  const memberSetId = isRecord(sets.body) ? records(sets.body.sets).find((set) => set.kind === "member_default")?.id : null;
  if (typeof memberSetId !== "string") throw new Error("Missing the Member permissions set");

  /** Saves each action's rules on a set, as the Rules tab does; actions left out are cleared. */
  async function saveRules(setId: string, rules: TeamRule[], as = den.admin) {
    let status = 200;
    for (const action of ["shell", "webfetch", "skill", "mcp"] as const) {
      const saved = await seed.api(as, `/v1/permissions/sets/${encodeURIComponent(setId)}/rules`, {
        method: "PUT",
        body: JSON.stringify({ action, rules: rules.filter((rule) => rule.action === action).map(({ resource, effect }) => ({ resource, effect })) }),
      });
      if (as === den.admin && !saved.response.ok) throw new Error(`Saving ${action} rules failed: HTTP ${saved.response.status} ${saved.text.slice(0, 500)}`);
      status = saved.response.status;
    }
    return status;
  }

  return {
    den,
    teamId,
    contractorsSetId,
    saveTeamRules: (rules: TeamRule[]) => saveRules(contractorsSetId, rules),
    saveMemberRules: (rules: TeamRule[]) => saveRules(memberSetId, rules),
    /** Riley trying to change the Contractors rules through the API. */
    memberSaveStatus: () => saveRules(contractorsSetId, [], riley),
    enableTeamRules: () => enableOrganizationCapabilities(seed, den.admin, { permissionRules: true }),
    /** The rules a member's desktop app and OpenWork Web receive, in the order they apply. */
    async receivedRules(member: "riley" | "morgan") {
      const config = await seed.api(member === "riley" ? riley : morgan, "/v1/me/desktop-config");
      if (!config.response.ok || !isRecord(config.body)) throw new Error(`Reading desktop config failed: HTTP ${config.response.status}`);
      return records(config.body.rules);
    },
  };
}
