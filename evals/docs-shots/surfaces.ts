import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { go, waitFor } from "@openwork/behaviors";
import { navigate } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import type { App } from "@openwork/testkit/stack";
import { provider } from "./ctx.ts";
import type { Provider } from "./ctx.ts";
import { inPage } from "./inpage.ts";
import type { SeededOrg } from "./seed.ts";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const WEB_DEMO_WORKSPACE = "/tmp/openwork-web-demo/acme-robotics";

export interface WorkspaceModel {
  providerId: string;
  modelId: string;
  baseUrl: string;
}

export interface ShotSurface extends Surface {
  open(path: string): Promise<void>;
}

export interface DesktopShotSurface extends App, ShotSurface {
  organization: SeededOrg;
  model: WorkspaceModel;
}

export interface DenWebSurface extends ShotSurface {
  organization: SeededOrg;
}

interface HeadlessWebInfo {
  webUrl: string;
  workspace: string;
  denTarget: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function configureWorkspaceModel(app: App, model: WorkspaceModel): Promise<void> {
  const configured = await inPage(app, `async (args) => {
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
    const patched = await request("/workspace/" + encodeURIComponent(args.workspaceId) + "/config", {
      method: "PATCH",
      body: JSON.stringify({
        opencode: {
          provider: {
            [args.providerId]: {
              npm: "@ai-sdk/openai-compatible",
              name: "OpenWork",
              options: { baseURL: args.baseUrl, apiKey: "sk-docs-shots" },
              models: { [args.modelId]: { name: "OpenWork", tool_call: true } },
            },
          },
        },
      }),
    });
    if (patched !== "ok") return patched;
    const reloaded = await request("/workspace/" + encodeURIComponent(args.workspaceId) + "/engine/reload", { method: "POST" });
    if (reloaded !== "ok" && !reloaded.includes("opencode_reload_timeout")) return reloaded;
    const raw = localStorage.getItem("openwork.preferences");
    let preferences = {};
    try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: args.providerId, modelID: args.modelId },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.defaultModel", args.providerId + "/" + args.modelId);
    localStorage.removeItem("openwork.sessionModels." + args.workspaceId);
    return "ok";
  }`, {
    workspaceId: app.workspaceId,
    providerId: model.providerId,
    modelId: model.modelId,
    baseUrl: model.baseUrl,
  }, { awaitPromise: true, timeoutMs: 90_000 });
  if (configured !== "ok") throw new Error(`Configuring the workspace model failed: ${String(configured)}`);
  await inPage(app, `() => { location.reload(); return true; }`, {});
  await waitFor(app, "Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop control after reload" });
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "session.create_task" && !action.disabled)`, {
    timeoutMs: 60_000,
    label: "desktop ready after model configuration",
  });
}

export function desktop(options: {
  org: Provider<SeededOrg>;
  app: string;
  model: Provider<WorkspaceModel>;
}): Provider<DesktopShotSurface> {
  return provider(async (ctx) => {
    const organization = await ctx.use(options.org);
    const app = organization.world.app(options.app);
    const model = await ctx.use(options.model);
    await configureWorkspaceModel(app, model);
    return {
      ...app,
      organization,
      model,
      open: (path) => go(app, path),
    };
  });
}

export function denWeb(options: { org: Provider<SeededOrg>; as: string }): Provider<DenWebSurface> {
  return provider(async (ctx) => {
    const organization = await ctx.use(options.org);
    const member = options.as === "admin" ? organization.den.admin : organization.den.members[options.as];
    if (!member) throw new Error(`Unknown Den member ${JSON.stringify(options.as)}.`);
    const browser = await chrome({
      name: "docs-shots-den-web",
      startUrl: organization.den.ref.webUrl,
      headless: true,
      host: organization.place.host(),
    });
    ctx.onDispose(() => browser[Symbol.asyncDispose]());
    await waitFor(browser, `location.href.startsWith(${JSON.stringify(organization.den.ref.webUrl)}) && document.readyState === "complete"`, {
      timeoutMs: 60_000,
      label: "Den Web origin before auth token handoff",
    });
    const stored = await inPage(browser, `(args) => {
      localStorage.setItem("openwork:web:auth-token", args.token);
      return localStorage.getItem("openwork:web:auth-token") === args.token;
    }`, { token: member.token });
    if (stored !== true) throw new Error("Storing the Den Web auth token failed.");
    return {
      ...browser,
      organization,
      open: async (path) => {
        await navigate(browser.client, `${organization.den.ref.webUrl}${path}`);
        await waitFor(browser, `document.readyState === "complete"`, {
          timeoutMs: 60_000,
          label: `Den Web ${path}`,
        });
      },
    };
  });
}

function parseHeadlessWebInfo(raw: string): HeadlessWebInfo | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed) && typeof parsed.webUrl === "string" && parsed.webUrl.startsWith("http")) {
      return {
        webUrl: parsed.webUrl,
        workspace: typeof parsed.workspace === "string" ? parsed.workspace : "",
        denTarget: typeof parsed.denTarget === "string" ? parsed.denTarget : "",
      };
    }
  } catch {
    return null;
  }
  return null;
}

async function headlessWebHealthy(info: HeadlessWebInfo): Promise<boolean> {
  try {
    const response = await fetch(info.webUrl, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureHeadlessWeb(denWebUrl: string): Promise<HeadlessWebInfo> {
  const infoPath = resolve(REPO_ROOT, "tmp/dev-headless-web.json");
  const onDemoWorkspace = (info: HeadlessWebInfo) => resolve(info.workspace) === WEB_DEMO_WORKSPACE;
  const onWorldDen = (info: HeadlessWebInfo) => info.denTarget === denWebUrl;
  const readInfo = async (): Promise<HeadlessWebInfo | null> => {
    const raw = await readFile(infoPath, "utf8").catch(() => null);
    return raw ? parseHeadlessWebInfo(raw) : null;
  };
  const existing = await readInfo();
  if (existing && onDemoWorkspace(existing) && onWorldDen(existing) && (await headlessWebHealthy(existing))) return existing;
  await mkdir(WEB_DEMO_WORKSPACE, { recursive: true });
  const args = ["dev:headless-web", "--detach"];
  if (existing && (!onDemoWorkspace(existing) || !onWorldDen(existing))) {
    args.push("--replace");
    if (!onDemoWorkspace(existing)) await rm(resolve(REPO_ROOT, "tmp/headless-server.json"), { force: true });
  }
  const child = spawn("pnpm", args, {
    cwd: REPO_ROOT,
    stdio: "ignore",
    detached: true,
    env: {
      ...process.env,
      OPENWORK_WORKSPACE: WEB_DEMO_WORKSPACE,
      OPENWORK_DEV_DEN_PROXY_TARGET: denWebUrl,
    },
  });
  child.unref();
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const info = await readInfo();
    if (info && onDemoWorkspace(info) && onWorldDen(info) && (await headlessWebHealthy(info))) return info;
    await delay(2_000);
  }
  throw new Error(`dev:headless-web did not become healthy on ${WEB_DEMO_WORKSPACE}; check ${infoPath}`);
}

export function webTab(options: { org: Provider<SeededOrg> }): Provider<ShotSurface> {
  return provider(async (ctx) => {
    const organization = await ctx.use(options.org);
    const info = await ensureHeadlessWeb(organization.den.ref.webUrl);
    const browser = await chrome({
      name: "docs-shots-web-tab",
      startUrl: info.webUrl,
      headless: true,
      host: organization.place.host(),
    });
    ctx.onDispose(() => browser[Symbol.asyncDispose]());
    return {
      ...browser,
      open: async (path) => {
        await navigate(browser.client, new URL(path, info.webUrl).toString());
        await waitFor(browser, `document.readyState === "complete"`, {
          timeoutMs: 60_000,
          label: `OpenWork Web ${path}`,
        });
      },
    };
  });
}
