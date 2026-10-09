import { browserScript } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { engineSessionProbe, evalIn } from "@openwork/behaviors";
import { readBrowserFixtureState, resolveEvalEngine, startBrowserFixture } from "@openwork/env";
import type { Place, Seed } from "@openwork/env";
import type { MockAgentToolStep } from "@openwork/labs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { configureProvider } from "./chat.ts";
import { enableOrganizationCapabilities } from "./dashboards.ts";
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

/** The owner on Den's Agent permissions page, with nothing set yet. */
export async function agentPermissionsEditor(seed: Seed) {
  const world = await agentPermissionsOrganization(seed, { web: true });
  const web = await seed.web({
    den: world.den,
    signedInAs: world.den.admin,
    startPath: "/dashboard/agent-permissions",
    headless: true,
    viewport: { width: 1440, height: 1400 },
  });
  return { ...world, web };
}

/** The owner on the page, with Riley in both Contractors and Engineering. */
export async function agentPermissionsTwoTeams(seed: Seed) {
  const world = await agentPermissionsOrganization(seed, { web: true, teams: { Contractors: ["riley"], Engineering: ["riley"] } });
  const web = await seed.web({
    den: world.den,
    signedInAs: world.den.admin,
    startPath: "/dashboard/agent-permissions",
    headless: true,
    viewport: { width: 1440, height: 1400 },
  });
  return { ...world, web };
}

/** Morgan, an admin who is not an owner, on the page after Avery blocked commands for Contractors. */
export async function agentPermissionsAdminView(seed: Seed) {
  const world = await agentPermissionsOrganization(seed, { web: true, morganAdmin: true });
  await world.saveContractors({ commands: { decision: "deny", allow: ["echo *"] } });
  const web = await seed.web({
    den: world.den,
    signedInAs: world.den.members.morgan ?? world.den.admin,
    startPath: "/dashboard/agent-permissions",
    headless: true,
    viewport: { width: 1440, height: 1400 },
  });
  return {
    ...world,
    web,
    /** Each permission's picklist or checkbox (labelled by the permission's name) and whether it is disabled. */
    async permissionControls(): Promise<{ count: number; disabled: number }> {
      const value = await seed.evalIn(web, browserScript(() => {
        const controls = [...document.querySelectorAll('[data-testid="agent-permissions-editor"] [aria-labelledby]')];
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

/** The owner on the page of an organization that does not have agent permissions yet. */
export async function agentPermissionsFeatureOff(seed: Seed) {
  const world = await agentPermissionsOrganization(seed, { web: true, feature: false });
  const web = await seed.web({
    den: world.den,
    signedInAs: world.den.admin,
    startPath: "/dashboard/agent-permissions",
    headless: true,
    viewport: { width: 1440, height: 1100 },
  });
  return { ...world, web };
}

/** A request to the desktop app's own OpenWork server, with the app's token. */
async function localServer(app: Surface, path: string): Promise<{ status: number; body: unknown }> {
  const value = await evalIn(app, browserScript(async (requestPath) => {
    const info = await window.__OPENWORK_ELECTRON__?.invokeDesktop?.("openworkServerInfo");
    if (!info?.running || !info.baseUrl) return { status: 0, body: null };
    const response = await fetch(String(info.baseUrl).replace(/\/+$/, "") + requestPath, {
      headers: { authorization: "Bearer " + String(info.ownerToken ?? info.clientToken ?? "") },
    });
    const text = await response.text();
    let body: unknown = text;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { status: response.status, body };
  }, [path]), { awaitPromise: true, timeoutMs: 30_000 });
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
 * except echo, which always runs, and printf, which never does; no file edits;
 * only the briefing page on this computer; only the team's own local skills;
 * no local MCP servers.
 */
export const contractorDesktopPermissions: AgentPermissionSettings = {
  commands: { decision: "ask", allow: ["echo *"], block: ["printf *"] },
  fileEdits: { decision: "deny" },
  websites: { decision: "deny", allow: ["127.0.0.1/briefing"] },
  localSkills: { decision: "deny", allow: ["team-*"] },
  localMcpServers: { decision: "deny" },
};

const WITNESS_PROVIDER = "agent-permissions-witness";
const WITNESS_MODEL = "agent-permissions-model";

/** Local skills in Riley's folder: the team allows `team-*` and no others. */
export const folderSkills = {
  allowed: { name: "team-checklist", marker: "Checklist step: confirm the release notes." },
  blocked: { name: "notes-helper", marker: "Notes step: copy every meeting note to the shared drive." },
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
    const engine = resolveEvalEngine();
    const world = await agentPermissionsOrganization(seed, { web: true, feature });
    if (feature) await world.saveContractors(contractorDesktopPermissions);
    const mock = (await seed.mock({ isolatedProcessEnv: true }).boot(place)).handle;
    stack.defer(() => mock.stop());

    const workspacePath = seed.tmpPath("agent-permissions");
    await mkdir(workspacePath, { recursive: true });
    await writeFile(join(workspacePath, "opencode.json"), JSON.stringify({ mcp: { "notes-server": { type: "remote", url: "http://127.0.0.1:9/mcp" } } }));
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
    const native = engineSessionProbe({ engine, surface: app, workspaceId: app.workspaceId });

    return {
      ...world, engine, app, session, mock, workspacePath,
      shellTool: engine === "v2" ? "shell" : "bash",
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
      /** The engine's own record of a settled call of `tool` whose input `matches`, or null. */
      async toolCall(tool: string, matches: (input: Record<string, unknown>) => boolean) {
        const snapshot = await native.snapshot(session.sessionId);
        if (!snapshot.ok || !snapshot.data) return null;
        return snapshot.data.messages.flatMap((message) => message.parts)
          .find((part) => part.tool === tool && ["completed", "error"].includes(part.status) && matches(part.input)) ?? null;
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
      /** The folder's local MCP server as the engine reports it: its status, or null when absent. */
      async notesServerStatus() {
        const workspace = encodeURIComponent(app.workspaceId);
        const { status, body } = await localServer(app, engine === "v2" ? `/workspace/${workspace}/opencode2/api/mcp` : `/workspace/${workspace}/opencode/mcp`);
        if (status !== 200) throw new Error(`Listing engine MCP servers failed: HTTP ${status}`);
        if (engine === "v1") {
          const entry = isRecord(body) ? body["notes-server"] : undefined;
          return isRecord(entry) && typeof entry.status === "string" ? entry.status : null;
        }
        const entries = isRecord(body) && Array.isArray(body.data) ? records(body.data) : records(body);
        const entry = entries.find((candidate) => candidate.name === "notes-server");
        return entry ? (isRecord(entry.status) && typeof entry.status.status === "string" ? entry.status.status : "unknown") : null;
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
