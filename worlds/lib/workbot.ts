import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { allocateFreePorts } from "../../evals/packages/cdp/src/index.ts";
import { denFetch } from "../../evals/packages/behaviors/src/den.ts";
import { publishCalendarModels } from "./calendar.ts";
import { server } from "../../evals/packages/env/src/den.ts";
import type { Den } from "../../evals/packages/env/src/den.ts";
import { resolvePlace } from "../../evals/packages/env/src/place.ts";
import type { Place } from "../../evals/packages/env/src/place.ts";
import { defaultDaytonaExec } from "../../evals/packages/hosts/src/daytona.ts";
import { privateSandboxId, privateWebPreview } from "../../evals/packages/hosts/src/private-web-preview.ts";
import { deleteSandboxes, execInSandbox, provisionWebSandbox, startScriptOnSandbox } from "../../evals/packages/hosts/src/provision.ts";
import { trackResource } from "../../packages/world/src/ledger.ts";
import { output, secret } from "../../packages/world/src/outputs.ts";
import type { WorldOutput } from "../../packages/world/src/outputs.ts";
import { receiptName, resolveStage } from "../../packages/world/src/stage.ts";
import { ACME_MODEL, ACME_REPLY, record, startAcmeUpstream } from "./acme-gateway.ts";
import { bootDemoWorkspace, connectDemoWorkspace, DEMO_WORKSPACE_SERVICES, type DemoWorkspace } from "./demo-workspace.ts";

/**
 * Workbot with everything it runs on: the seeded Acme Den (where people sign in), the headless runner (where the
 * conversation runs) and the Workbot app, wired the way production is. The Acme org has the demo Slack, Notion,
 * Linear, Google Calendar and Gmail (in-memory, worlds/lib/demo-workspace.ts) connected.
 *
 * By default the model is the deterministic Acme upstream and the runner's computer is off, so no paid key enters
 * the world. `--live` (local only) is for feeling the product: a real model, Workbot's own computer (background
 * tasks), and the "Order calculator" MCP App seeded into the org (worlds/mcp-apps-demo.ts).
 */

import { workbotProbeAuthorizeUrl } from "./workbot-auth.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKBOT_WORLD = "preview-workbot";
// A preview VM's services keep template origins; these preloads translate them (see each file).
const PREVIEW_EGRESS = new URL("../../packages/freestyle/src/egress.mjs", import.meta.url).href;
const PREVIEW_LOOPBACK = new URL("../../packages/freestyle/src/loopback.mjs", import.meta.url).href;
const DAYTONA_WORKBOT_PORT = 3020;
const DAYTONA_RUNNER_PORT = 8795;
const DAYTONA_UPSTREAM_PORT = 3990;
const DAYTONA_LIFETIME_MINUTES = 120;
const execFileAsync = promisify(execFile);

/** `--live`: a real model, the computer on, and an MCP App seeded. Local placement only. */
export type WorkbotWorldOptions = {
  live: boolean;
  /**
   * `--calendar`: seed the owner's Automations and runs, turn on the desktop and Workbot Calendars, and read
   * meetings from the calendar mock (worlds/lib/calendar.ts).
   */
  calendar?: boolean;
  /** Extra Den settings (e.g. provider base URLs a spec points at a mock). */
  denEnv?: Record<string, string>;
  /** Workbot reads meetings from this calendar mock instead of Den (WORKBOT_CALENDAR_MOCK_URL). */
  workbotCalendarMockUrl?: string;
  upstream?: { baseUrl: string; key: string; model: string };
  runnerProxy?: (runnerUrl: string) => Promise<string>;
  /** Extra runner settings, for example a small HEADLESS_CONTEXT_CHAR_BUDGET so a short journey outgrows the context. */
  runnerEnv?: Record<string, string>;
  /** Features turned on for the seeded organization besides Workbot itself, for example `workbotSideChats`. */
  features?: Record<string, boolean>;
};

export function parseWorkbotOptions(argv: string[]): WorkbotWorldOptions {
  for (const arg of argv) if (arg !== "--live" && arg !== "--calendar") throw new Error(`preview-workbot: unknown option ${arg} (supported: --live, --calendar)`);
  return { live: argv.includes("--live"), calendar: argv.includes("--calendar") };
}

/** A secret from the caller's environment, else the team's dev Infisical; never printed. */
async function secretFromEnvOrInfisical(names: string[], infisical: { name: string; path?: string }): Promise<string | null> {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  const args = ["secrets", "get", infisical.name, "--env", "dev", "--plain", "--silent", ...(infisical.path ? ["--path", infisical.path] : [])];
  const found = await execFileAsync("infisical", args, { timeout: 30_000 }).then((result) => result.stdout.trim()).catch(() => "");
  return found && found !== "*not found*" ? found : null;
}

/** The runner's model and computer: the Acme upstream and no computer, or (live) a real model and Freestyle. */
async function runnerModel(stack: AsyncDisposableStack, live: boolean, fixture?: WorkbotWorldOptions["upstream"]) {
  if (!live) {
    const upstream = fixture ?? await startAcmeUpstream(stack);
    return {
      env: { HEADLESS_MODEL_PROTOCOL: "anthropic", HEADLESS_MODEL_BASE_URL: `${upstream.baseUrl}/v1`, HEADLESS_MODEL: fixture?.model ?? ACME_MODEL, HEADLESS_MODEL_API_KEY: upstream.key, HEADLESS_COMPUTER: "off" },
      upstreamKey: upstream.key, model: fixture?.model ?? ACME_MODEL, computer: false,
    };
  }
  const key = await secretFromEnvOrInfisical(["HEADLESS_MODEL_API_KEY", "ANTHROPIC_API_KEY"], { name: "ANTHROPIC_API_KEY" });
  if (!key) throw new Error("preview-workbot --live needs a model key: set ANTHROPIC_API_KEY (or HEADLESS_MODEL_API_KEY), or log in to Infisical.");
  const model = process.env.HEADLESS_MODEL?.trim() || "claude-sonnet-5-5";
  const freestyle = await secretFromEnvOrInfisical(["FREESTYLE_API_KEY"], { name: "FREESTYLE_API_KEY", path: "/openwork-ops" });
  if (freestyle) {
    // A no-op unless the computer image changed; then it builds the new snapshot (about three minutes).
    await execFileAsync("pnpm", ["--filter", "@openwork-ee/headless-computer", "snapshot:build"], {
      cwd: REPO_ROOT, env: { ...process.env, FREESTYLE_API_KEY: freestyle }, maxBuffer: 16 * 1024 * 1024, timeout: 900_000,
    });
  }
  return {
    env: {
      HEADLESS_MODEL_PROTOCOL: process.env.HEADLESS_MODEL_PROTOCOL?.trim() || "anthropic",
      HEADLESS_MODEL_BASE_URL: process.env.HEADLESS_MODEL_BASE_URL?.trim() || "https://api.anthropic.com/v1",
      HEADLESS_MODEL: model, HEADLESS_MODEL_API_KEY: key,
      ...(freestyle ? { HEADLESS_COMPUTER: "freestyle", FREESTYLE_API_KEY: freestyle } : { HEADLESS_COMPUTER: "off" }),
    },
    upstreamKey: "", model, computer: Boolean(freestyle),
  };
}

/** Kills whatever listens on a loopback port (the App demo's Inventory server runs detached). */
async function stopListener(port: number) {
  const pids = await execFileAsync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"]).then((result) => result.stdout.split("\n").filter(Boolean)).catch(() => []);
  for (const pid of pids) try { process.kill(Number(pid), "SIGTERM"); } catch { /* already gone */ }
}

/**
 * Seeds the "Order calculator" MCP App (with its mock Inventory connection and two Workflows) into the Acme org,
 * through OpenWork Connect's create_app, as worlds/mcp-apps-demo.ts does.
 */
async function seedOrderCalculator(stack: AsyncDisposableStack, den: Den): Promise<{ title: string; pluginPage: string }> {
  const [inventoryPort] = await allocateFreePorts(1);
  stack.defer(() => stopListener(inventoryPort));
  const result = await execFileAsync(process.execPath, [
    "worlds/mcp-apps-demo.ts", "--den-api", den.ref.apiUrl, "--den-web", den.ref.webUrl,
    "--email", den.admin.email, "--password", den.admin.password, "--inventory-port", String(inventoryPort),
  ], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024, timeout: 300_000 });
  const parsed: unknown = JSON.parse(result.stdout);
  const app = record(parsed) && record(parsed.app) ? parsed.app : {};
  return {
    title: typeof app.title === "string" ? app.title : "Order calculator",
    pluginPage: record(parsed) && typeof parsed.pluginPage === "string" ? parsed.pluginPage : `${den.ref.webUrl}/dashboard`,
  };
}

export interface WorkbotWorld {
  den: Den;
  orgId: string;
  /** Where a browser opens Workbot; Den sends people back here after signing in. */
  workbotUrl: string;
  /** Where this process reaches Workbot (loopback, except on Daytona). */
  workbotInternal: string;
  /** Den web as browsers see it, and as this process reaches it. */
  denWebPublic: string;
  runnerUrl: string;
  secrets: { runnerToken: string; sessionSecret: string; upstreamKey: string };
  live: boolean;
  model: string;
  computer: boolean;
  demo: DemoWorkspace | null;
  app: { title: string; pluginPage: string } | null;
}

const token = () => randomBytes(32).toString("base64url");

/** A service of this world as a child process, killed with the world; ready once its health URL answers. */
async function startService(stack: AsyncDisposableStack, input: {
  label: string; cwd: string; args: string[]; env: Record<string, string>; health: string; match: string;
}) {
  const child = spawn(process.execPath, input.args, {
    cwd: input.cwd,
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...input.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  let failure: Error | undefined;
  child.on("error", (error) => { failure = error; });
  const capture = (chunk: Buffer) => { logs = `${logs}${chunk.toString()}`.slice(-6000); };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  stack.defer(async () => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  });
  if (child.pid) await trackResource({ kind: "process", id: String(child.pid), label: input.label, match: input.match });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    if (failure || child.exitCode !== null) throw new Error(`${input.label} failed to start: ${failure?.message ?? logs}`);
    if (await fetch(input.health, { signal: AbortSignal.timeout(2000) }).then((response) => response.ok).catch(() => false)) return;
    await delay(500);
  }
  throw new Error(`${input.label} did not become healthy: ${logs}`);
}

/** Turns Workbot (and headless Automations, and any `features`) on for the seeded organization, as a platform admin does. */
export async function enableWorkbot(den: Den, features: Record<string, boolean> = {}): Promise<string> {
  const headers = { authorization: `Bearer ${den.admin.token}` };
  const orgs = await denFetch(den.admin, "/v1/me/orgs", { headers });
  const org = record(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs.find(record) : undefined;
  if (!orgs.response.ok || !org || typeof org.id !== "string") throw new Error("Acme organization missing.");
  const updated = await denFetch(den.admin, `/v1/admin/organizations/${org.id}/capabilities`, {
    method: "PUT", headers, body: JSON.stringify({ capabilities: { workbot: true, headlessAutomations: true, ...features } }),
  });
  if (!updated.response.ok) throw new Error(`Could not turn Workbot on: HTTP ${updated.response.status} ${updated.text.slice(0, 200)}`);
  return org.id;
}

/** Builds the Workbot app (page and server) unless the snapshot already did. */
async function buildWorkbot() {
  if (process.env.OPENWORK_WORKBOT_PREBUILT === "1") return;
  await execFileAsync("pnpm", ["--filter", "@openwork-ee/workbot", "build"], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024, timeout: 600_000 });
}

/**
 * Den, the runner and Workbot on this machine (also inside a Freestyle VM, where `preview` holds the snapshot's
 * template origins and the edge gateway translates them for browsers).
 */
export async function bootWorkbot(stack: AsyncDisposableStack, preview?: { den: string; workbot: string }, options: WorkbotWorldOptions = { live: false }): Promise<WorkbotWorld> {
  const place = resolvePlace();
  if (place.kind !== "local") throw new Error("bootWorkbot runs next to MySQL (--place local, or inside a prepared VM).");
  if (options.live && preview) throw new Error("preview-workbot --live runs locally only.");
  const runner = await runnerModel(stack, options.live, options.upstream);
  const [runnerPort, workbotPort] = await allocateFreePorts(2);
  const runnerUrl = `http://127.0.0.1:${runnerPort}`;
  const workbotInternal = `http://127.0.0.1:${workbotPort}`;
  const workbotUrl = preview?.workbot ?? workbotInternal;
  const secrets = { runnerToken: token(), sessionSecret: token(), upstreamKey: runner.upstreamKey };
  const den = stack.use(await server({
    place, web: true, seedProfile: "demo-org", seedAutomations: options.calendar === true,
    env: {
      DEN_WORKBOT_URL: workbotUrl, DEN_HEADLESS_RUNNER_URL: runnerUrl, DEN_HEADLESS_RUNNER_TOKEN: secrets.runnerToken,
      RESEND_API_KEY: "", SMTP_HOST: "",
      // Its own sign-in cookie names: a browser shares 127.0.0.1's cookies across ports, so another local Den's
      // sign-in must never be read (or overwritten) by this world's Den.
      DEN_AUTH_COOKIE_PREFIX: `openwork-den-${randomBytes(4).toString("hex")}`,
      // Eval Dens leave Apps built in OpenWork off; --live seeds one, as production has them on.
      ...(options.live ? { DEN_APP_MCP_SERVERS_ENABLED: "true" } : {}),
      ...options.denEnv,
      ...(preview ? {
        DEN_WEB_ALLOWED_DEV_ORIGINS: new URL(preview.den).hostname,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${PREVIEW_EGRESS}`].filter(Boolean).join(" "),
      } : {}),
    },
    trustedOrigins: preview ? Object.values(preview) : [],
    publicOrigins: preview ? { web: preview.den, api: preview.den } : undefined,
  }));
  const name = `${receiptName(WORKBOT_WORLD, resolveStage(process.env))}-${randomUUID().slice(0, 8)}`;
  const data = join(REPO_ROOT, "tmp", "worlds", name);
  await mkdir(data, { recursive: true });
  await startService(stack, {
    label: "workbot-runner", match: "src/server.ts",
    cwd: join(REPO_ROOT, "ee/apps/headless-runner"),
    args: ["--conditions=development", "--import", "tsx", "src/server.ts"],
    health: `${runnerUrl}/health`,
    env: {
      HEADLESS_API_TOKEN: secrets.runnerToken, HEADLESS_PORT: String(runnerPort), HEADLESS_DB_PATH: join(data, "runner.sqlite"),
      ...runner.env, HEADLESS_MCP_URL: `${den.ref.apiUrl}/mcp/agent`,
      HEADLESS_FILES: "disk", HEADLESS_FILES_DIR: join(data, "files"),
      ...options.runnerEnv,
    },
  });
  await buildWorkbot();
  await startService(stack, {
    label: "workbot", match: "dist/server.js",
    cwd: join(REPO_ROOT, "ee/apps/workbot"),
    args: ["dist/server.js"],
    health: `${workbotInternal}/healthz`,
    env: {
      PORT: String(workbotPort), WORKBOT_PUBLIC_URL: workbotUrl, WORKBOT_DEN_API_URL: den.ref.apiUrl,
      WORKBOT_DEN_WEB_URL: preview?.den ?? den.ref.webUrl, WORKBOT_RUNNER_URL: options.runnerProxy ? await options.runnerProxy(runnerUrl) : runnerUrl, WORKBOT_RUNNER_TOKEN: secrets.runnerToken,
      WORKBOT_SESSION_SECRET: secrets.sessionSecret,
      ...(options.workbotCalendarMockUrl ? { WORKBOT_CALENDAR_MOCK_URL: options.workbotCalendarMockUrl } : {}),
      ...(preview ? {
        // Workbot reaches Den's sign-in at its advertised (template) origin; inside the VM that is loopback.
        NODE_OPTIONS: `--import=${PREVIEW_LOOPBACK}`,
        OPENWORK_PREVIEW_LOOPBACK: JSON.stringify({ [new URL(preview.den).hostname]: { web: den.ref.webUrl, api: den.ref.apiUrl } }),
      } : {}),
    },
  });
  // --calendar turns on both Calendars (desktop and Workbot), each behind its own feature.
  const orgId = await enableWorkbot(den, { ...options.features, ...(options.calendar ? { automationCalendar: true, workbotCalendar: true } : {}) });
  // --calendar: a real provider (Anthropic, fixture key) so the Calendar's model pickers show logos and choices.
  if (options.calendar) await publishCalendarModels(den.admin, orgId);
  // The Acme team's apps (in memory), so Workbot has a real-looking calendar, inbox and Slack to read.
  const demo = await bootDemoWorkspace(stack, den);
  await connectDemoWorkspace(den, demo);
  const app = options.live ? await seedOrderCalculator(stack, den) : null;
  return {
    den, orgId, workbotUrl, workbotInternal, denWebPublic: preview?.den ?? den.ref.webUrl, runnerUrl, secrets,
    live: options.live, model: runner.model, computer: runner.computer, demo, app,
  };
}

/** Daytona interposes a warning page for browsers; scripted requests skip it. */
const DAYTONA_SKIP_WARNING = { "x-daytona-skip-preview-warning": "true" };

/**
 * The signed URLs are the only way in: without the token Daytona must refuse Workbot and the runner outright, and
 * with it Workbot serves its page and the runner answers. Nothing is published until this holds.
 */
async function verifyWorkbotPreviews(workbot: { browserOrigin: string; unsignedOrigin: string }, runner: { browserOrigin: string; unsignedOrigin: string }) {
  const get = (url: string) => fetch(url, { redirect: "manual", headers: DAYTONA_SKIP_WARNING, signal: AbortSignal.timeout(30_000) });
  for (const url of [`${workbot.unsignedOrigin}/`, `${workbot.unsignedOrigin}/healthz`, `${workbot.unsignedOrigin}/v1/workbot/me`, `${runner.unsignedOrigin}/health`]) {
    const denied = await get(url);
    await denied.body?.cancel();
    if (![401, 403].includes(denied.status)) throw new Error("Security prerequisite: unsigned access to Workbot or the runner was not denied. No URL published.");
  }
  const page = await get(`${workbot.browserOrigin}/`);
  if (!page.ok || !(await page.text()).includes("<div id=\"root\">")) throw new Error(`Workbot's signed URL did not serve the page (HTTP ${page.status}).`);
  for (const url of [`${workbot.browserOrigin}/healthz`, `${runner.browserOrigin}/health`]) {
    const healthy = await get(url);
    await healthy.body?.cancel();
    if (!healthy.ok) throw new Error(`A signed URL did not answer: HTTP ${healthy.status}`);
  }
}

/** Cookie pairs (`name=value`) a response set, merged over earlier ones. */
function withCookies(jar: Map<string, string>, response: Response) {
  for (const line of response.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const at = pair?.indexOf("=") ?? -1;
    if (pair && at > 0) jar.set(pair.slice(0, at).trim(), pair.slice(at + 1));
  }
  return jar;
}
const cookieHeader = (jar: Map<string, string>) => [...jar].map(([key, value]) => `${key}=${value}`).join("; ");

/**
 * Signs in to Workbot the way a person does (Workbot → Den's OAuth authorize → back with a code), as the seeded
 * owner, then sends one message and waits for the runner's answer. Proves Den sign-in, the runner, its model and
 * Workbot's live conversation together.
 */
export async function signInWorkbot(world: WorkbotWorld, options: { denInternal?: string } = {}) {
  const denInternal = options.denInternal ?? world.den.ref.webUrl;
  const toInternal = (url: string) => url.replace(world.denWebPublic, denInternal).replace(world.workbotUrl, world.workbotInternal);
  const workbotJar = new Map<string, string>();
  const login = await fetch(`${world.workbotInternal}/auth/login?return=/`, { redirect: "manual", headers: DAYTONA_SKIP_WARNING, signal: AbortSignal.timeout(30_000) });
  withCookies(workbotJar, login);
  const authorize = login.headers.get("location");
  if (login.status !== 302 || !authorize) throw new Error(`Workbot sign-in did not start: HTTP ${login.status}`);

  const denJar = new Map<string, string>();
  const auth = (path: string, body: unknown) => fetch(`${world.den.ref.apiUrl}${path}`, {
    method: "POST", redirect: "manual", signal: AbortSignal.timeout(30_000),
    headers: { ...DAYTONA_SKIP_WARNING, "content-type": "application/json", origin: world.denWebPublic, cookie: cookieHeader(denJar) },
    body: JSON.stringify(body),
  });
  const signedIn = await auth("/api/auth/sign-in/email", { email: world.den.admin.email, password: world.den.admin.password });
  withCookies(denJar, signedIn);
  if (!signedIn.ok) throw new Error(`Den sign-in failed: HTTP ${signedIn.status}`);
  // A fresh session has no workspace yet; a person picks one on Den's picker.
  const active = await auth("/api/auth/organization/set-active", { organizationId: world.orgId });
  withCookies(denJar, active);
  if (!active.ok) throw new Error(`Could not choose the Acme workspace: HTTP ${active.status}`);

  const granted = await fetch(workbotProbeAuthorizeUrl(authorize, world.denWebPublic, world.den.ref.apiUrl), {
    redirect: "manual", signal: AbortSignal.timeout(30_000),
    headers: { ...DAYTONA_SKIP_WARNING, cookie: cookieHeader(denJar), origin: world.denWebPublic },
  });
  const callback = granted.headers.get("location") ?? "";
  if (granted.status !== 302 || !callback.startsWith(`${world.workbotUrl}/auth/callback?`)) {
    throw new Error(`Den did not return to Workbot: HTTP ${granted.status} ${callback.slice(0, 160)}`);
  }
  const returned = await fetch(toInternal(callback), { redirect: "manual", signal: AbortSignal.timeout(30_000), headers: { ...DAYTONA_SKIP_WARNING, cookie: cookieHeader(workbotJar) } });
  withCookies(workbotJar, returned);
  if (returned.status !== 302) throw new Error(`Workbot did not finish signing in: HTTP ${returned.status} ${(await returned.text()).slice(0, 200)}`);

  const call = (path: string, init: RequestInit = {}) => fetch(`${world.workbotInternal}${path}`, {
    ...init, signal: AbortSignal.timeout(30_000),
    headers: { ...DAYTONA_SKIP_WARNING, cookie: cookieHeader(workbotJar), origin: world.workbotUrl, accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}) },
  });
  const me = await call("/v1/workbot/me");
  const who: unknown = await me.json().catch(() => null);
  if (!me.ok || !record(who) || who.enabled !== true) throw new Error(`Workbot does not see Alex with Workbot on: HTTP ${me.status}`);
  return { call, cookie: cookieHeader(workbotJar) };
}

export async function probeWorkbot(world: WorkbotWorld, options: { denInternal?: string } = {}) {
  const { call } = await signInWorkbot(world, options);
  // Live: leave the conversation untouched, so the person's first open is a real first open (Workbot says hello).
  if (world.live) return { reply: "the conversation is left empty for your first open" };
  const sent = await call("/v1/workbot/messages", { method: "POST", body: JSON.stringify({ id: `probe${randomUUID().replaceAll("-", "").slice(0, 16)}`, text: "Hello from the world check." }) });
  if (sent.status !== 202) throw new Error(`Workbot refused the message: HTTP ${sent.status} ${(await sent.text()).slice(0, 200)}`);
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const read = await call("/v1/workbot?turns=5");
    const thread: unknown = await read.json().catch(() => null);
    const turns = record(thread) && Array.isArray(thread.turns) ? thread.turns.filter(record) : [];
    const last = turns.at(-1);
    if (last?.status === "done" && JSON.stringify(last.parts).includes(ACME_REPLY)) return { reply: ACME_REPLY };
    if (last?.status === "failed") throw new Error(`Workbot's answer failed: ${String(last.error)}`);
    await delay(1000);
  }
  throw new Error("Workbot did not answer within two minutes.");
}

export function workbotOutputs(world: WorkbotWorld, extra: Record<string, WorldOutput> = {}): Record<string, WorldOutput> {
  return {
    workbotUrl: output(world.workbotUrl, { group: "URLs", note: "Sign in as alex@acme.test; Den picks the Acme workspace" }),
    denWeb: output(world.denWebPublic, { group: "URLs" }),
    denApi: output(world.den.ref.apiUrl, { group: "URLs" }),
    runnerUrl: output(world.runnerUrl, { group: "Headless runner", note: "Private service; Workbot and Den reach it with the runner token" }),
    model: output(world.model, { group: "Headless runner", note: world.live ? "Real model (live)" : "Deterministic Acme upstream; no paid inference keys" }),
    ...(world.live ? {} : { reply: output(ACME_REPLY, { group: "Headless runner" }) }),
    computer: output(world.computer ? "on (Freestyle)" : "off", { group: "Headless runner", note: world.computer ? "Background tasks run on Workbot's own computer" : "No background tasks; --live with a Freestyle key turns it on" }),
    ...(world.demo ? {
      demoApps: output(DEMO_WORKSPACE_SERVICES.map((service) => service.name).join(", "), { group: "Demo apps", note: "Acme Robotics demo data (you are Alex Chen); reads and writes stay in memory until the world stops" }),
      ...(world.demo.stateUrl ? { demoState: output(world.demo.stateUrl, { group: "Demo apps", note: "Live demo data; POST /reset restores the seed" }) } : {}),
    } : {}),
    ...(world.app ? { mcpApp: output(world.app.title, { group: "Demo apps", note: `MCP App in the Acme library: ${world.app.pluginPage}` }) } : {}),
    capabilities: output("workbot, headlessAutomations", { group: "Org", note: "Turned on for Acme Robotics" }),
    alexEmail: output(world.den.admin.email, { group: "Accounts", note: "org owner and platform admin" }),
    alexPassword: secret(world.den.admin.password, { group: "Accounts" }),
    runnerToken: secret(world.secrets.runnerToken, { group: "Headless runner" }),
    ...extra,
  };
}

/** Starts a repository process inside a Daytona sandbox's checkout through a tiny uploaded launcher. */
const LAUNCHER = `import { spawn } from "node:child_process";
const args = JSON.parse(process.env.OPENWORK_LAUNCH_ARGS);
const child = spawn(process.execPath, args, { cwd: process.env.OPENWORK_LAUNCH_CWD, env: process.env, stdio: "inherit" });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
child.on("exit", (code) => process.exit(code ?? 1));
`;

/**
 * preview-workbot on Daytona: Den in its own sandbox (as preview-den), and the runner, Workbot and the fake model in
 * one private sandbox at the same commit. Workbot's signed URL exists before Den starts, so Den is configured with it.
 */
export async function bootWorkbotOnDaytona(stack: AsyncDisposableStack, place: Place): Promise<Record<string, WorldOutput>> {
  const { createWorldDaytonaExec } = await import("../../evals/packages/hosts/src/sandbox-daytona.ts");
  const exec = await createWorldDaytonaExec();
  const base = place.denBase();
  if (base.kind !== "daytona") throw new Error("preview-workbot on Daytona needs a pinned Daytona ref.");
  const name = `${receiptName(WORKBOT_WORLD, resolveStage(process.env))}-${randomUUID().slice(0, 8)}`;
  let sandboxId: string | undefined;
  const room = await provisionWebSandbox({
    exec, ref: base.ref, name, private: true, autoStopMinutes: 0,
    onCreated: async (created) => {
      sandboxId = await privateSandboxId(created, exec);
      await trackResource({ kind: "app-web-daytona", id: sandboxId, match: sandboxId, label: name });
    },
  });
  stack.defer(() => deleteSandboxes([sandboxId ?? room.sandbox], { exec }));
  if (!sandboxId || !room.created) throw new Error("preview-workbot did not receive an owned private sandbox.");
  const lifetime = (DAYTONA_LIFETIME_MINUTES + 10) * 60;
  const issuedAt = Date.now();
  const workbotPreview = await privateWebPreview(sandboxId, DAYTONA_WORKBOT_PORT, exec, lifetime);
  const runnerPreview = await privateWebPreview(sandboxId, DAYTONA_RUNNER_PORT, exec, lifetime);
  const secrets = { runnerToken: token(), sessionSecret: token(), upstreamKey: randomUUID() };
  const den = stack.use(await server({
    place, web: true, seedProfile: "demo-org", daytonaAutoStopMinutes: 0,
    env: {
      DEN_WORKBOT_URL: workbotPreview.browserOrigin, DEN_HEADLESS_RUNNER_URL: runnerPreview.browserOrigin,
      DEN_HEADLESS_RUNNER_TOKEN: secrets.runnerToken, RESEND_API_KEY: "", SMTP_HOST: "",
    },
  }));
  const upstream = await startScriptOnSandbox({
    exec, sandbox: sandboxId, label: "acme-upstream", port: DAYTONA_UPSTREAM_PORT,
    scriptSource: await readFile(fileURLToPath(new URL("../../evals/packages/labs/src/acme-upstream.mjs", import.meta.url)), "utf8"),
    env: { ACME_UPSTREAM_KEY: secrets.upstreamKey, ACME_MODEL, ACME_REPLY },
    log: (line) => console.error(`[preview-workbot] ${line}`),
  });
  stack.defer(() => upstream.stop().catch(() => undefined));
  const built = await execInSandbox(exec, sandboxId, "cd /workspace && pnpm --filter @openwork-ee/workbot build > /tmp/workbot-build.log 2>&1; status=$?; tail -20 /tmp/workbot-build.log; exit $status", {
    timeoutMs: 900_000, context: "Workbot build",
  });
  if (built.code !== 0) throw new Error(`Workbot build failed in the sandbox: ${built.stdout.slice(-800)}`);
  const runner = await startScriptOnSandbox({
    exec, sandbox: sandboxId, label: "workbot-runner", port: DAYTONA_RUNNER_PORT, healthPath: "/health", scriptSource: LAUNCHER,
    env: {
      OPENWORK_LAUNCH_CWD: "/workspace/ee/apps/headless-runner",
      OPENWORK_LAUNCH_ARGS: JSON.stringify(["--conditions=development", "--import", "tsx", "src/server.ts"]),
      HEADLESS_API_TOKEN: secrets.runnerToken, HEADLESS_PORT: String(DAYTONA_RUNNER_PORT), HEADLESS_DB_PATH: "/tmp/workbot-world/runner.sqlite",
      HEADLESS_MODEL_PROTOCOL: "anthropic", HEADLESS_MODEL_BASE_URL: `${upstream.loopbackUrl}/v1`, HEADLESS_MODEL: ACME_MODEL,
      HEADLESS_MODEL_API_KEY: secrets.upstreamKey, HEADLESS_MCP_URL: `${den.ref.apiUrl}/mcp/agent`,
      HEADLESS_FILES: "disk", HEADLESS_FILES_DIR: "/tmp/workbot-world/files", HEADLESS_COMPUTER: "off",
    },
    log: (line) => console.error(`[preview-workbot] ${line}`),
  });
  stack.defer(() => runner.stop().catch(() => undefined));
  const workbot = await startScriptOnSandbox({
    exec, sandbox: sandboxId, label: "workbot-app", port: DAYTONA_WORKBOT_PORT, healthPath: "/healthz", scriptSource: LAUNCHER,
    env: {
      OPENWORK_LAUNCH_CWD: "/workspace/ee/apps/workbot", OPENWORK_LAUNCH_ARGS: JSON.stringify(["dist/server.js"]),
      WORKBOT_PUBLIC_URL: workbotPreview.browserOrigin, WORKBOT_DEN_API_URL: den.ref.apiUrl, WORKBOT_DEN_WEB_URL: den.ref.webUrl,
      WORKBOT_RUNNER_URL: `http://127.0.0.1:${DAYTONA_RUNNER_PORT}`, WORKBOT_RUNNER_TOKEN: secrets.runnerToken,
      WORKBOT_SESSION_SECRET: secrets.sessionSecret,
    },
    log: (line) => console.error(`[preview-workbot] ${line}`),
  });
  stack.defer(() => workbot.stop().catch(() => undefined));
  await verifyWorkbotPreviews(workbotPreview, runnerPreview);
  const orgId = await enableWorkbot(den);
  const world: WorkbotWorld = {
    den, orgId, workbotUrl: workbotPreview.browserOrigin, workbotInternal: workbotPreview.browserOrigin,
    denWebPublic: den.ref.webUrl, runnerUrl: runnerPreview.browserOrigin, secrets,
    live: false, model: ACME_MODEL, computer: false, demo: null, app: null,
  };
  const proof = await probeWorkbot(world);
  return workbotOutputs(world, {
    workbotUrl: secret(world.workbotUrl, { group: "URLs", note: "Private signed URL; sign in as alex@acme.test" }),
    runnerUrl: secret(world.runnerUrl, { group: "Headless runner", note: "Private signed URL; needs the runner token" }),
    verified: output(`Signed in through Den and answered: ${proof.reply}`, { group: "Verification" }),
    previewExpires: output(new Date(issuedAt + lifetime * 1000).toISOString(), { group: "World" }),
    ...(den.placement?.kind === "daytona" ? { denSandbox: output(den.placement.sandboxId, { group: "World" }) } : {}),
    workbotSandbox: output(sandboxId, { group: "World" }),
  });
}
