import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { denFetch, evalIn, waitFor, createOrgConnection, createPluginWithSkill } from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import type { AttachedSurface } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { app, mcpMock, resolvePlace, server } from "@openwork/testkit/stack";
import type { App, Den, Place } from "@openwork/testkit/stack";
import { startModelWitness, WITNESS_MODEL_ID, WITNESS_PROVIDER_ID } from "./witness.ts";
import type { ModelWitness } from "./witness.ts";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Docs-grade seed content: realistic names, no eval/test vocabulary. */
export const SEED = {
  orgName: "Acme Robotics",
  adminName: "Alex Rivera",
  adminEmail: "alex@acme.dev",
  plugins: [
    {
      name: "Customer Research",
      description: "Prepare for sales calls with a structured company brief.",
      skillName: "customer-research",
      skillDescription: "Research a company and summarize key facts before a sales call.",
      skillBody: "# Instructions\n\n1. Gather the company's product, size, and recent news.\n2. Summarize the three facts that matter for this call.\n3. Suggest one opening question.",
    },
    {
      name: "Weekly Status Report",
      description: "Draft the weekly status update from recent activity.",
      skillName: "weekly-status-report",
      skillDescription: "Draft the weekly status update from this week's activity.",
      skillBody: "# Instructions\n\n1. Collect what shipped, what slipped, and what is blocked.\n2. Write a five-line update in the team's usual format.",
    },
    {
      name: "Meeting Notes",
      description: "Turn a transcript into structured meeting notes.",
      skillName: "meeting-notes",
      skillDescription: "Turn a meeting transcript into decisions, owners, and follow-ups.",
      skillBody: "# Instructions\n\n1. Extract decisions, owners, and deadlines from the transcript.\n2. List open questions at the end.",
    },
  ],
  slackConnectionName: "Slack",
} as const;

export interface SeededCloud {
  den: Den;
  orgId: string;
  /** Plugin ids in the order of SEED.plugins. */
  pluginIds: string[];
  /** An MCP gateway token for the admin (used by the chat scene). */
  mcpToken: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readOrganizationId(admin: DenSession): Promise<string> {
  const { response, body, text } = await denFetch(admin, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${admin.token}` },
  });
  const orgs = isRecord(body) && Array.isArray(body.orgs) ? body.orgs.filter(isRecord) : [];
  const id = orgs[0] && typeof orgs[0].id === "string" ? orgs[0].id : "";
  if (!response.ok || !id) throw new Error(`Resolving the organization failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  return id;
}

async function mintMcpToken(admin: DenSession, orgId: string): Promise<string> {
  const { response, body, text } = await denFetch(admin, "/v1/mcp/token", {
    method: "POST",
    headers: { authorization: `Bearer ${admin.token}`, "x-openwork-org-id": orgId },
    body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const token = isRecord(body) && typeof body.token === "string" ? body.token : "";
  if (!response.ok || !token) throw new Error(`Minting an MCP token failed: HTTP ${response.status} ${text.slice(0, 300)}`);
  return token;
}

interface HeadlessWebInfo {
  webUrl: string;
  workspace: string;
}

/** OpenWork Web scenes show this workspace instead of the repository checkout. */
export const WEB_DEMO_WORKSPACE = "/tmp/openwork-web-demo/acme-robotics";

function parseHeadlessWebInfo(raw: string): HeadlessWebInfo | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.webUrl === "string" && parsed.webUrl.startsWith("http")) {
      return { webUrl: parsed.webUrl, workspace: typeof parsed.workspace === "string" ? parsed.workspace : "" };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Shared environment for all scenes. Everything is lazy: a scene run only
 * boots the surfaces it actually uses. Dispose tears everything down.
 */
export class Stage {
  readonly place: Place = resolvePlace(process.env);
  private cloudPromise: Promise<SeededCloud> | null = null;
  private witnessPromise: Promise<ModelWitness> | null = null;
  private desktopPromise: Promise<App> | null = null;
  private denWebPromise: Promise<AttachedSurface> | null = null;
  private webTabPromise: Promise<AttachedSurface> | null = null;
  private readonly cleanups: Array<() => PromiseLike<void>> = [];

  registerCleanup(cleanup: () => PromiseLike<void>): void {
    this.cleanups.push(cleanup);
  }

  /** Local Den with the seeded Acme Robotics organization. */
  cloud(): Promise<SeededCloud> {
    this.cloudPromise ??= (async () => {
      const den = await server({
        place: this.place,
        org: { name: SEED.orgName, admin: { name: SEED.adminName, email: SEED.adminEmail } },
        mocks: { slack: mcpMock() },
      });
      this.registerCleanup(() => den[Symbol.asyncDispose]());
      const orgId = await readOrganizationId(den.admin);
      const capabilities = await denFetch(den.admin, `/v1/admin/organizations/${orgId}/capabilities`, {
        method: "PUT",
        headers: { authorization: `Bearer ${den.admin.token}` },
        body: JSON.stringify({ capabilities: { workflows: true, mcpConnections: true, cloud: true } }),
      });
      if (!capabilities.response.ok) {
        throw new Error(`Enabling org capabilities failed: HTTP ${capabilities.response.status} ${capabilities.text.slice(0, 300)}`);
      }
      const pluginIds: string[] = [];
      for (const plugin of SEED.plugins) {
        const created = await createPluginWithSkill(den.admin, plugin);
        pluginIds.push(created.id);
      }
      const slack = den.mocks.slack;
      if (!slack) throw new Error("The slack MCP mock was not provisioned.");
      await createOrgConnection(den.admin, {
        name: SEED.slackConnectionName,
        url: slack.mcpUrl,
        authType: "oauth",
        credentialMode: "per_member",
        access: { orgWide: true },
      });
      const mcpToken = await mintMcpToken(den.admin, orgId);
      return { den, orgId, pluginIds, mcpToken };
    })();
    return this.cloudPromise;
  }

  /** The deterministic model witness scenes configure as the workspace model. */
  witness(): Promise<ModelWitness> {
    this.witnessPromise ??= (async () => {
      const witness = await startModelWitness();
      this.registerCleanup(witness.close);
      return witness;
    })();
    return this.witnessPromise;
  }

  /**
   * The desktop app, signed in to the seeded organization as the admin, on a
   * docs-grade workspace ("acme-robotics") whose engine has a configured
   * model (the witness) so no unconfigured-engine errors can leak into shots.
   */
  desktop(): Promise<App> {
    this.desktopPromise ??= (async () => {
      const { den } = await this.cloud();
      const desktopApp = await app({
        den,
        as: "admin",
        place: this.place,
        workspacePath: "/tmp/acme/acme-robotics",
      });
      this.registerCleanup(() => desktopApp[Symbol.asyncDispose]());
      const witness = await this.witness();
      await this.configureWorkspaceModel(desktopApp, desktopApp.workspaceId, witness.url);
      return desktopApp;
    })();
    return this.desktopPromise;
  }

  private async configureWorkspaceModel(desktopApp: App, workspaceId: string, witnessUrl: string): Promise<void> {
    const configured = await evalIn(desktopApp, `(async () => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      if (!port || !token) return "missing local server credentials";
      const request = async (path, init) => {
        const response = await fetch("http://127.0.0.1:" + port + path, {
          ...init,
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        });
        if (!response.ok) return path + " failed: " + response.status + " " + (await response.text()).slice(0, 500);
        return "ok";
      };
      const workspaceId = ${JSON.stringify(workspaceId)};
      const patched = await request("/workspace/" + encodeURIComponent(workspaceId) + "/config", {
        method: "PATCH",
        body: JSON.stringify({
          opencode: {
            provider: {
              [${JSON.stringify(WITNESS_PROVIDER_ID)}]: {
                npm: "@ai-sdk/openai-compatible",
                name: "OpenWork",
                options: { baseURL: ${JSON.stringify(`${witnessUrl}/v1`)}, apiKey: "sk-docs-shots" },
                models: { [${JSON.stringify(WITNESS_MODEL_ID)}]: { name: "OpenWork", tool_call: true } },
              },
            },
          },
        }),
      });
      if (patched !== "ok") return patched;
      const reloaded = await request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
      if (reloaded !== "ok" && !reloaded.includes("opencode_reload_timeout")) return reloaded;
      const raw = localStorage.getItem("openwork.preferences");
      let preferences = {};
      try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
      if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
      localStorage.setItem("openwork.preferences", JSON.stringify({
        ...preferences,
        defaultModel: { providerID: ${JSON.stringify(WITNESS_PROVIDER_ID)}, modelID: ${JSON.stringify(WITNESS_MODEL_ID)} },
        modelVariant: null,
        providerStepCompleted: true,
      }));
      localStorage.setItem("openwork.defaultModel", ${JSON.stringify(`${WITNESS_PROVIDER_ID}/${WITNESS_MODEL_ID}`)});
      localStorage.removeItem("openwork.sessionModels." + workspaceId);
      return "ok";
    })()`, { awaitPromise: true, timeoutMs: 90_000 });
    if (configured !== "ok") throw new Error(`Configuring the workspace model failed: ${String(configured)}`);
    await evalIn(desktopApp, "location.reload(); true");
    await waitFor(desktopApp, "Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop control after reload" });
    await waitFor(desktopApp, `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`, {
      timeoutMs: 60_000,
      label: "desktop ready after model configuration",
    });
  }

  /** Headless Chrome on the Den dashboard, authenticated as the admin. */
  async denWeb(route: string): Promise<AttachedSurface> {
    this.denWebPromise ??= (async () => {
      const { den } = await this.cloud();
      const browser = await chrome({
        name: "docs-shots-den-web",
        startUrl: den.ref.webUrl,
        headless: true,
        host: this.place.host(),
      });
      this.registerCleanup(() => browser[Symbol.asyncDispose]());
      await waitFor(browser, `location.href.startsWith(${JSON.stringify(den.ref.webUrl)}) && document.readyState === "complete"`, {
        timeoutMs: 60_000,
        label: "Den Web origin before auth token handoff",
      });
      const stored = await evalIn(browser, `(() => {
        localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(den.admin.token)});
        return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(den.admin.token)};
      })()`);
      if (stored !== true) throw new Error("Storing the Den Web auth token failed.");
      return browser;
    })();
    const browser = await this.denWebPromise;
    const { den } = await this.cloud();
    await navigate(browser.client, `${den.ref.webUrl}${route}`);
    await waitFor(browser, `document.readyState === "complete"`, { timeoutMs: 60_000, label: `Den Web ${route}` });
    return browser;
  }

  /** Headless Chrome on the local OpenWork Web instance (dev:headless-web). */
  webTab(): Promise<AttachedSurface> {
    this.webTabPromise ??= (async () => {
      const info = await this.ensureHeadlessWeb();
      const browser = await chrome({
        name: "docs-shots-web-tab",
        startUrl: info.webUrl,
        headless: true,
        host: this.place.host(),
      });
      this.registerCleanup(() => browser[Symbol.asyncDispose]());
      return browser;
    })();
    return this.webTabPromise;
  }

  private async ensureHeadlessWeb(): Promise<HeadlessWebInfo> {
    const infoPath = resolve(REPO_ROOT, "tmp/dev-headless-web.json");
    const onDemoWorkspace = (info: HeadlessWebInfo) => resolve(info.workspace) === WEB_DEMO_WORKSPACE;
    const readInfo = async (): Promise<HeadlessWebInfo | null> => {
      const raw = await readFile(infoPath, "utf8").catch(() => null);
      return raw ? parseHeadlessWebInfo(raw) : null;
    };
    const existing = await readInfo();
    if (existing && onDemoWorkspace(existing) && (await this.headlessWebHealthy(existing))) return existing;
    await mkdir(WEB_DEMO_WORKSPACE, { recursive: true });
    const args = ["dev:headless-web", "--detach"];
    if (existing && !onDemoWorkspace(existing)) {
      // Start from a clean isolated server config so the previous checkout
      // workspace does not linger in the workspace list.
      args.push("--replace");
      await rm(resolve(REPO_ROOT, "tmp/headless-server.json"), { force: true });
    }
    const child = spawn("pnpm", args, {
      cwd: REPO_ROOT,
      stdio: "ignore",
      detached: true,
      env: { ...process.env, OPENWORK_WORKSPACE: WEB_DEMO_WORKSPACE },
    });
    child.unref();
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const info = await readInfo();
      if (info && onDemoWorkspace(info) && (await this.headlessWebHealthy(info))) return info;
      await delay(2_000);
    }
    throw new Error(`dev:headless-web did not become healthy on ${WEB_DEMO_WORKSPACE}; check ${infoPath}`);
  }

  private async headlessWebHealthy(info: HeadlessWebInfo): Promise<boolean> {
    try {
      const response = await fetch(info.webUrl, { signal: AbortSignal.timeout(5_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async dispose(): Promise<void> {
    for (const cleanup of this.cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        console.error("cleanup failed:", error);
      }
    }
    this.cleanups.length = 0;
  }
}
