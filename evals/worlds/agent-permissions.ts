import { browserScript } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { engineSessionProbe, evalIn } from "@openwork/behaviors";
import { readBrowserFixtureState, startBrowserFixture } from "@openwork/env";
import type { Place, Seed } from "@openwork/env";
import type { MockAgentToolStep } from "@openwork/labs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configureProvider } from "./chat.ts";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";
import { isRecord, records } from "./library.ts";

/** One permission's setting as Den's Agent permissions page saves it. */
export type AgentPermissionSetting = { decision?: "allow" | "ask" | "deny"; allow?: string[]; block?: string[] };
export type AgentPermissionSettings = Record<string, AgentPermissionSetting>;
export type AgentPermissionMember = "riley" | "morgan";

type OrganizationOptions = {
  web: boolean;
  /** A platform admin has turned agent permissions on for the organization. */
  feature?: boolean;
  /** Each team's name and members. */
  teams?: Record<string, AgentPermissionMember[]>;
  /** Morgan is an organization admin, but not an owner. */
  morganAdmin?: boolean;
};

/**
 * An organization Avery owns, with Riley and Morgan as members and the given
 * teams (by default Riley alone in Contractors). Nothing is set yet, as for
 * an organization that has just been given the feature.
 */
async function agentPermissionsOrganization(seed: Seed, options: OrganizationOptions) {
  const den = await seed.den({
    web: options.web,
    org: {
      name: `Agent Permissions ${Date.now()}`,
      admin: { name: "Avery Owner" },
      members: { riley: { name: "Riley Contractor" }, morgan: { name: "Morgan Staff" } },
    },
  });
  const sessions = { riley: den.members.riley, morgan: den.members.morgan };
  const { riley, morgan } = sessions;
  if (!riley || !morgan) throw new Error("seed.den() did not provision the member sessions");
  const context = await seed.api(den.admin, "/v1/org");
  const organization = isRecord(context.body) && isRecord(context.body.organization) ? context.body.organization : null;
  if (!context.response.ok || typeof organization?.id !== "string") throw new Error(`Reading the organization failed: ${context.text.slice(0, 500)}`);
  const organizationId = organization.id;
  const scope = { "x-openwork-org-id": organizationId };
  const memberIds: Partial<Record<AgentPermissionMember, string>> = {};
  for (const name of ["riley", "morgan"] as const) {
    const org = await seed.api(sessions[name] ?? riley, "/v1/org");
    const member = isRecord(org.body) && isRecord(org.body.currentMember) ? org.body.currentMember : null;
    if (!org.response.ok || typeof member?.id !== "string") throw new Error(`Reading ${name}'s membership failed: ${org.text.slice(0, 500)}`);
    memberIds[name] = member.id;
  }
  const teamIds: Record<string, string> = {};
  const teams: Record<string, AgentPermissionMember[]> = options.teams ?? { Contractors: ["riley"] };
  for (const [name, members] of Object.entries(teams)) {
    const team = await seed.api(den.admin, "/v1/teams", {
      method: "POST", headers: scope,
      body: JSON.stringify({ name, memberIds: members.map((member) => memberIds[member]) }),
    });
    const teamId = isRecord(team.body) && isRecord(team.body.team) ? team.body.team.id : null;
    if (!team.response.ok || typeof teamId !== "string") throw new Error(`Setting up ${name} failed: ${team.text.slice(0, 500)}`);
    teamIds[name] = teamId;
  }
  if (options.morganAdmin) {
    const promoted = await seed.api(den.admin, `/v1/members/${encodeURIComponent(memberIds.morgan ?? "")}/role`, {
      method: "POST", headers: scope, body: JSON.stringify({ role: "admin" }),
    });
    if (!promoted.response.ok) throw new Error(`Making Morgan an admin failed: HTTP ${promoted.response.status} ${promoted.text.slice(0, 300)}`);
  }
  const enableFeature = () => enableOrganizationCapabilities(seed, den.admin, { agentPermissions: true }, organizationId);
  if (options.feature !== false) await enableFeature();
  const scopePath = (team?: string) => team === undefined
    ? "/v1/agent-permissions/everyone"
    : `/v1/agent-permissions/teams/${encodeURIComponent(teamIds[team] ?? team)}`;
  /** Saves everyone's permissions, or a team's, the way the Agent permissions page does. */
  const save = async (settings: AgentPermissionSettings, team?: string) => {
    const saved = await seed.api(den.admin, scopePath(team), { method: "PUT", headers: scope, body: JSON.stringify({ settings }) });
    if (!saved.response.ok) throw new Error(`Saving ${team ?? "everyone's"} permissions failed: HTTP ${saved.response.status} ${saved.text.slice(0, 500)}`);
  };
  /** What happens when a member, or Morgan as an admin, tries to change everyone's permissions. */
  const saveStatus = async (member: AgentPermissionMember) => {
    const attempt = await seed.api(sessions[member] ?? riley, scopePath(), { method: "PUT", body: JSON.stringify({ settings: {} }) });
    return attempt.response.status;
  };

  return {
    den,
    organizationId,
    teamIds,
    /** The Contractors team's id, the team most journeys change. */
    teamId: teamIds.Contractors ?? "",
    enableFeature,
    save,
    saveContractors: (settings: AgentPermissionSettings) => save(settings, "Contractors"),
    saveStatus,
    memberSaveStatus: () => saveStatus("riley"),
    /** What happens when someone opens the permissions through the API. */
    async readStatus(member: AgentPermissionMember | "owner") {
      const read = await seed.api(member === "owner" ? den.admin : sessions[member] ?? riley, "/v1/agent-permissions");
      return read.response.status;
    },
    /** The rules a member's desktop app receives, in the order they apply. */
    async receivedRules(member: AgentPermissionMember) {
      const config = await seed.api(sessions[member] ?? riley, "/v1/me/desktop-config");
      if (!config.response.ok || !isRecord(config.body)) throw new Error(`Reading desktop config failed: HTTP ${config.response.status}`);
      return isRecord(config.body.agentPermissions) ? records(config.body.agentPermissions.rules) : null;
    },
  };
}

const EVERYONE_AGENTS = "/dashboard/members/teams/everyone?tab=agents";
const teamAgents = (teamId: string | undefined) => `/dashboard/members/teams/${encodeURIComponent(teamId ?? "")}?tab=agents`;

async function ownerOn(seed: Seed, world: Awaited<ReturnType<typeof agentPermissionsOrganization>>, startPath: string, height = 1400) {
  return seed.web({ den: world.den, signedInAs: world.den.admin, startPath, headless: true, viewport: { width: 1440, height } });
}

/** The owner on Members › Teams › Everyone's Agents tab, with nothing set yet. */
export async function agentPermissionsEditor(seed: Seed) {
  const world = await agentPermissionsOrganization(seed, { web: true });
  return { ...world, web: await ownerOn(seed, world, EVERYONE_AGENTS) };
}

/** The owner on the Contractors team's Agents tab, with nothing set yet. */
export async function agentPermissionsTeamTab(seed: Seed) {
  const world = await agentPermissionsOrganization(seed, { web: true });
  return { ...world, web: await ownerOn(seed, world, teamAgents(world.teamId)) };
}

/** The owner on Members › Teams, with Riley in Sales and Morgan in no team. */
export async function agentPermissionsSales(seed: Seed) {
  const world = await agentPermissionsOrganization(seed, { web: true, teams: { Sales: ["riley"] } });
  return { ...world, salesId: world.teamIds.Sales ?? "", saveSales: (settings: AgentPermissionSettings) => world.save(settings, "Sales"), web: await ownerOn(seed, world, "/dashboard/members?tab=teams") };
}

/** The owner on Engineering's Agents tab, with Riley in both Contractors and Engineering. */
export async function agentPermissionsTwoTeams(seed: Seed) {
  const world = await agentPermissionsOrganization(seed, { web: true, teams: { Contractors: ["riley"], Engineering: ["riley"] } });
  return { ...world, web: await ownerOn(seed, world, teamAgents(world.teamIds.Engineering)) };
}

/** Morgan, an admin who is not an owner, on Contractors' Agents tab after Avery blocked commands for Contractors. */
export async function agentPermissionsAdminView(seed: Seed) {
  const world = await agentPermissionsOrganization(seed, { web: true, morganAdmin: true });
  await world.saveContractors({ commands: { decision: "deny", allow: ["echo *"] } });
  const web = await seed.web({
    den: world.den,
    signedInAs: world.den.members.morgan ?? world.den.admin,
    startPath: teamAgents(world.teamId),
    headless: true,
    viewport: { width: 1440, height: 1400 },
  });
  return {
    ...world,
    web,
    /** Each permission's picklist or checkbox (labelled by the permission's name) and whether it is disabled. */
    async permissionControls(): Promise<{ count: number; disabled: number }> {
      const value = await seed.evalIn(web, browserScript(() => {
        const controls = [...document.querySelectorAll('[data-testid="agent-permissions-editor"] [aria-labelledby], [data-testid="agent-permissions-editor"] [role="switch"]')];
        return {
          count: controls.length,
          disabled: controls.filter((control) => control.hasAttribute("disabled") || control.getAttribute("aria-disabled") === "true").length,
        };
      }, []));
      if (!isRecord(value) || typeof value.count !== "number" || typeof value.disabled !== "number") throw new Error("Reading the permission controls failed");
      return { count: value.count, disabled: value.disabled };
    },
  };
}

/** The owner on Contractors' Agents tab in an organization that does not have agent permissions yet. */
export async function agentPermissionsFeatureOff(seed: Seed) {
  const world = await agentPermissionsOrganization(seed, { web: true, feature: false });
  return { ...world, web: await ownerOn(seed, world, teamAgents(world.teamId), 1100) };
}

/** A request to the desktop app's own OpenWork server, with the app's token. */
async function localServer(app: Surface, path: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
  const value = await evalIn(app, browserScript(async (requestPath, method, requestBody) => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { status: 0, body: null };
    const response = await fetch(String(info.baseUrl).replace(/\/+$/, "") + requestPath, {
      method,
      headers: {
        authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? ""),
        ...(requestBody === null ? {} : { "content-type": "application/json" }),
      },
      ...(requestBody === null ? {} : { body: JSON.stringify(requestBody) }),
    });
    const text = await response.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body };
  }, [path, init.method ?? "GET", init.body ?? null]), { awaitPromise: true, timeoutMs: 180_000 });
  if (!isRecord(value) || typeof value.status !== "number") throw new Error(`Invalid local server response for ${path}`);
  return { status: value.status, body: value.body };
}

async function createSession(seed: Seed, app: Surface, title: string): Promise<{ sessionId: string; title: string }> {
  const deadline = Date.now() + 90_000;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      return await seed.session(app, { title });
    } catch (error) {
      lastError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
  }
  throw new Error(`Session creation did not settle: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/**
 * What the Contractors team may do in the desktop journeys: commands ask first,
 * except echo, which always runs, and printf, which never does; file edits ask
 * first (blocking them would block every command too);
 * only the briefing page on this computer; no local skills and no local MCP
 * servers.
 */
export const contractorDesktopPermissions: AgentPermissionSettings = {
  commands: { decision: "ask", allow: ["echo *"], block: ["printf *"] },
  fileEdits: { decision: "ask" },
  websites: { decision: "deny", allow: ["127.0.0.1/briefing"] },
  localSkills: { decision: "deny" },
  localMcpServers: { decision: "deny" },
};

const WITNESS_PROVIDER = "agent-permissions-witness";
const WITNESS_MODEL = "agent-permissions-model";

/** Local skills in Riley's folder. */
export const folderSkills = {
  allowed: { name: "team-checklist", marker: "Checklist step: confirm the release notes." },
  blocked: { name: "notes-helper", marker: "Notes step: copy every meeting note to the shared drive." },
  /** A local skill named like the entries OpenWork lists for the organization's Cloud skills. */
  cloudNamed: { name: "openwork-cloud-handbook", marker: "Handbook step: email the handbook to every contact." },
} as const;

type BrowserTab = { id: string; url: string; label: string; loadError: string | null };

function browserTabs(state: unknown): BrowserTab[] {
  const tabs = isRecord(state) && Array.isArray(state.tabs) ? records(state.tabs) : [];
  return tabs.flatMap((tab) => typeof tab.id === "string" ? [{
    id: tab.id,
    url: typeof tab.url === "string" ? tab.url : "",
    label: typeof tab.label === "string" ? tab.label : "",
    loadError: isRecord(tab.loadError) && typeof tab.loadError.message === "string" ? tab.loadError.message : null,
  }] : []);
}

/**
 * Riley, in the Contractors team, works in the desktop app signed in to Den.
 * The folder's own config adds a local MCP server and the folder has two local
 * skills; a page server on Riley's computer serves a briefing and a private
 * report. The model is a witness that calls the tool each prompt names.
 */
export function agentPermissionsDesktop(seed: Seed, { place }: { place: Place }) {
  return desktopWorld(seed, place, { feature: true });
}

/**
 * The same desktop setup for an organization that has not turned agent
 * permissions on: Riley's app gets no rules, so nothing about the agent, the
 * folder's skills and MCP server, or the built-in browser changes.
 */
export function agentPermissionsDesktopFeatureOff(seed: Seed, { place }: { place: Place }) {
  return desktopWorld(seed, place, { feature: false });
}

async function desktopWorld(seed: Seed, place: Place, { feature }: { feature: boolean }) {
  const stack = new AsyncDisposableStack();
  try {
    const engine = "v2";
    const world = await agentPermissionsOrganization(seed, { web: true, feature });
    if (feature) await world.saveContractors(contractorDesktopPermissions);
    // The witness model, and the MCP server the folder adds.
    const mock = (await seed.mock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true }).boot(place)).handle;
    stack.defer(() => mock.stop());

    const workspacePath = seed.tmpPath("agent-permissions");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, "opencode.json"), JSON.stringify({ mcp: { "notes-server": { type: "remote", url: mock.mcpUrl, oauth: false } } }));
    for (const skill of Object.values(folderSkills)) {
      await mkdir(join(workspacePath, ".opencode", "skills", skill.name), { recursive: true });
      await writeFile(join(workspacePath, ".opencode", "skills", skill.name, "SKILL.md"),
        `---\nname: ${skill.name}\ndescription: Steps for ${skill.name.replace("-", " ")}.\n---\n${skill.marker}\n`);
    }
    const app = await seed.desktop({ name: "agent-permissions", den: world.den, as: "riley", workspacePath });
    // The app reloads its engine once Riley's rules arrive; a model or session
    // set up during that reload is retried.
    await configureProvider(seed, app, app.workspaceId, WITNESS_PROVIDER, WITNESS_MODEL, {
      provider: {
        [WITNESS_PROVIDER]: {
          npm: "@ai-sdk/openai-compatible", name: "Agent permissions witness",
          options: { baseURL: `${mock.url}/v1`, apiKey: "sk-agent-permissions-eval-only" },
          models: { [WITNESS_MODEL]: { name: "Agent permissions witness", tool_call: true } },
        },
      },
    }, engine);
    const pages = await startBrowserFixture(app, { requireSignIn: false });
    stack.defer(() => pages[Symbol.asyncDispose]());
    const session = await createSession(seed, app, "Contractor work");
    const native = engineSessionProbe({ surface: app, workspaceId: app.workspaceId });

    /** The engine's own records of the settled calls of `tool` whose input `matches`, oldest first. */
    const toolCalls = async (tool: string, matches: (input: Record<string, unknown>) => boolean) => {
      const snapshot = await native.snapshot(session.sessionId);
      if (!snapshot.ok || !snapshot.data) return [];
      return snapshot.data.messages.flatMap((message) => message.parts)
        .filter((part) => part.tool === tool && ["completed", "error"].includes(part.status) && matches(part.input));
    };
    /** Every MCP server the engine has, by name, with its status. */
    const mcpServers = async (): Promise<Record<string, string>> => {
      const workspace = encodeURIComponent(app.workspaceId);
      const { status, body } = await localServer(app, `/workspace/${workspace}/opencode2/api/mcp`);
      if (status !== 200) throw new Error(`Listing engine MCP servers failed: HTTP ${status}`);

      const entries = isRecord(body) && Array.isArray(body.data) ? records(body.data) : records(body);
      return Object.fromEntries(entries.flatMap((entry) => typeof entry.name === "string"
        ? [[entry.name, isRecord(entry.status) && typeof entry.status.status === "string" ? entry.status.status : "unknown"]]
        : []));
    };

    return {
      ...world, engine, app, session, mock, workspacePath,
      shellTool: "shell",
      /** The briefing page Contractors may open, and a report they may not. */
      briefingUrl: `${pages.origin}/briefing`,
      reportUrl: `${pages.origin}/private-report`,
      /** The witness model runs these tool calls when it sees the prompt's marker, then replies. */
      async prepareTurn(promptMarker: string, finalReply: string, steps: MockAgentToolStep[], finalReplyFrom?: "last-tool-text") {
        const response = await fetch(`${mock.url}/admin/agent-workloads`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workloads: [{ promptMarker, latestUserTurn: true, finalReply, steps, ...(finalReplyFrom ? { finalReplyFrom } : {}) }] }),
        });
        if (!response.ok) throw new Error("The witness model workload could not be configured");
      },
      toolCalls,
      /** The engine's own record of the first settled call of `tool` whose input `matches`, or null. */
      async toolCall(tool: string, matches: (input: Record<string, unknown>) => boolean) {
        return (await toolCalls(tool, matches))[0] ?? null;
      },
      /** The tools the engine offered the model for the turn with this marker. */
      async offeredTools(promptMarker: string) {
        const requests = await mock.agentRequests({ promptMarker, atLeast: 1, timeoutMs: 30_000 });
        return [...new Set(requests.flatMap((request) => request.advertisedToolNames ?? []))];
      },
      /** The agent permission rules the desktop app's OpenWork server enforces. */
      async enforcedRules() {
        const { status, body } = await localServer(app, "/managed-policy");
        if (status !== 200) throw new Error(`Reading the managed policy failed: HTTP ${status}`);
        const policy = isRecord(body) && isRecord(body.policy) ? body.policy : null;
        return policy && isRecord(policy.agentPermissions) ? records(policy.agentPermissions.rules) : [];
      },
      mcpServers,
      /**
       * Stops and starts the engine, as Riley quitting and reopening OpenWork
       * does, so it boots with the Contractors rules already stored. Resolves
       * once the engine is running again, or with the reason it did not start.
       */
      async restartEngine(): Promise<{ running: boolean; error: string | null }> {

        await seed.evalIn(app, browserScript(async () => {
          if (!window.__OPENWORK_ELECTRON__?.invokeDesktop) throw new Error("The desktop restart bridge is unavailable");
          await window.__OPENWORK_ELECTRON__.invokeDesktop("engineRestart", {});
          return true;
        }, []), { awaitPromise: true, timeoutMs: 120_000 });
        const deadline = Date.now() + 120_000;
        while (Date.now() < deadline) {
          const { body } = await localServer(app, "/engine/status");
          const lastError = isRecord(body) && typeof body.lastError === "string" ? body.lastError : null;
          if (isRecord(body) && body.running === true) return { running: true, error: lastError };
          if (lastError) return { running: false, error: lastError };
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
        }
        return { running: false, error: "The engine did not report running within 120 s" };
      },
      /** The folder's local MCP server as the engine reports it: its status, or null when absent. */
      async notesServerStatus() {
        return (await mcpServers())["notes-server"] ?? null;
      },
      wrote: (file: string) => access(join(workspacePath, file)).then(() => true, () => false),
      /** The paths Riley's computer served from the page server, by anyone. */
      async servedPages() {
        return (await readBrowserFixtureState(app, pages.origin)).pageRequests.map((request) => request.path);
      },
      /** Opens a page in a built-in browser tab of this conversation, as Riley does, and returns the tab once it settles. */
      async openTab(url: string): Promise<BrowserTab> {
        const created = await seed.evalIn(app, browserScript((url, sessionId) => window.__OPENWORK_ELECTRON__.browser.createTab(url, sessionId), [url, session.sessionId]), { awaitPromise: true });
        const tabId = isRecord(created) && typeof created.tabId === "string" ? created.tabId : "";
        const deadline = Date.now() + 20_000;
        while (Date.now() < deadline) {
          const tab = browserTabs(await seed.evalIn(app, () => window.__OPENWORK_ELECTRON__.browser.getState(), { awaitPromise: true })).find((entry) => entry.id === tabId);
          if (tab && (tab.loadError || (tab.url === url && tab.label !== "New tab"))) return tab;
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
        }
        throw new Error(`The built-in browser tab for ${url} did not settle.`);
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}

/**
 * The owner on Members › Teams before agent permissions are on, with Riley in
 * Contractors and Morgan in Engineering.
 */
export async function agentPermissionsTeamsList(seed: Seed) {
  const world = await agentPermissionsOrganization(seed, { web: true, feature: false, teams: { Contractors: ["riley"], Engineering: ["morgan"] } });
  const web = await seed.web({
    den: world.den,
    signedInAs: world.den.admin,
    startPath: "/dashboard/members?tab=teams",
    headless: true,
    viewport: { width: 1440, height: 900 },
  });
  return { ...world, web };
}

/** The owner on the dashboard, with agent permissions on and Riley in Contractors. */
export async function agentPermissionsMoved(seed: Seed) {
  const world = await agentPermissionsOrganization(seed, { web: true });
  const web = await seed.web({
    den: world.den,
    signedInAs: world.den.admin,
    startPath: "/dashboard",
    headless: true,
    viewport: { width: 1440, height: 1000 },
  });
  return { ...world, web, webUrl: world.den.ref.webUrl };
}

/** A team name longer than any Teams list lane, to show that rows stay one line. */
export const LONG_TEAM_NAME = "Customer Success and Implementation Partners for Europe and the Middle East";

/**
 * The owner on Members › Teams with agent permissions, team roles and shared
 * roles on, and names longer than the list's lanes: Sales Team has three
 * people with long names and its own "Sales Team Permissions" role, a second
 * team has a very long name, and Engineering asks before commands.
 */
export async function teamsListLongNames(seed: Seed) {
  const den = await seed.den({
    web: true,
    org: {
      name: `Teams List ${Date.now()}`,
      admin: { name: "Avery Owner" },
      members: {
        alexandra: { name: "Alexandra Montgomery-Whitfield" },
        bartholomew: { name: "Bartholomew Okonkwo-Lindqvist" },
        guillermina: { name: "Guillermina Castellanos" },
        riley: { name: "Riley Contractor" },
      },
    },
  });
  const context = await seed.api(den.admin, "/v1/org");
  const organization = isRecord(context.body) && isRecord(context.body.organization) ? context.body.organization : null;
  if (!context.response.ok || typeof organization?.id !== "string") throw new Error(`Reading the organization failed: ${context.text.slice(0, 500)}`);
  const organizationId = organization.id;
  const scope = { "x-openwork-org-id": organizationId };
  await enableOrganizationCapabilities(seed, den.admin, { agentPermissions: true, permissions: true, teamRoles: true, sharedRoles: true }, organizationId);
  const members = isRecord(context.body) ? records(context.body.members) : [];
  const memberId = (name: string) => {
    const id = members.find((member) => isRecord(member.user) && member.user.name === name)?.id;
    if (typeof id !== "string") throw new Error(`${name} is not a member of the organization`);
    return id;
  };
  const createTeam = async (name: string, people: string[]) => {
    const team = await seed.api(den.admin, "/v1/teams", { method: "POST", headers: scope, body: JSON.stringify({ name, memberIds: people.map(memberId) }) });
    const teamId = isRecord(team.body) && isRecord(team.body.team) ? team.body.team.id : null;
    if (!team.response.ok || typeof teamId !== "string") throw new Error(`Setting up ${name} failed: ${team.text.slice(0, 500)}`);
    return teamId;
  };
  const sales = await createTeam("Sales Team", ["Alexandra Montgomery-Whitfield", "Bartholomew Okonkwo-Lindqvist", "Guillermina Castellanos"]);
  await createTeam(LONG_TEAM_NAME, ["Riley Contractor", "Guillermina Castellanos"]);
  const engineering = await createTeam("Engineering", ["Riley Contractor"]);
  const role = await seed.api(den.admin, "/v1/permissions/sets", {
    method: "POST", headers: scope,
    body: JSON.stringify({ teamId: sales, permissions: [{ key: "plugins.import", status: "allow" }] }),
  });
  if (role.response.status !== 201) throw new Error(`Giving Sales Team its role failed: HTTP ${role.response.status} ${role.text.slice(0, 300)}`);
  const saved = await seed.api(den.admin, `/v1/agent-permissions/teams/${encodeURIComponent(engineering)}`, {
    method: "PUT", headers: scope, body: JSON.stringify({ settings: { commands: { decision: "ask" } } }),
  });
  if (!saved.response.ok) throw new Error(`Saving Engineering's permissions failed: HTTP ${saved.response.status} ${saved.text.slice(0, 300)}`);
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/members?tab=teams", headless: true, viewport: { width: 1440, height: 900 } });
  return { den, organizationId, web };
}
