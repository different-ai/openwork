import { defineFlow, type FlowContext } from "../runner/flow.ts";
import { loadVoiceoverParagraphs } from "../runner/voiceover.ts";

const FLOW_ID = "den-gateway";
const DEFAULT_FLOW_BASE_URL = "https://web.openworklabs.com";
const DEFAULT_DEN_WEB_URL = "https://app.openworklabs.com";
const MARKER_PATH = `cloud-workspace-overlay-${Date.now()}.txt`;
const MARKER_CONTENT = `cloud workspace overlay proof ${Date.now()}`;

const vo = await loadVoiceoverParagraphs(FLOW_ID);
if (!vo) throw new Error("Missing approved voice-over script for den-gateway.");

type CloudStatus = "provisioning" | "waking" | "ready" | "failed";
type CloudInstance = {
  status: CloudStatus;
  url: string | null;
  imageVersion: string | null;
  latestVersion: string | null;
};
type Org = {
  id: string;
  slug: string | null;
  name: string | null;
};
type JsonResult = {
  response: Response;
  body: unknown;
  text: string;
};

const state: {
  denToken: string;
  org: Org | null;
  cloudInstance: CloudInstance | null;
  staleAvailable: boolean;
  updateClicked: boolean;
  markerWritten: boolean;
} = {
  denToken: "",
  org: null,
  cloudInstance: null,
  staleAvailable: false,
  updateClicked: false,
  markerWritten: false,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value).slice(0, 1_200);
  } catch {
    return String(value).slice(0, 1_200);
  }
}

function witness(ctx: FlowContext, condition: unknown, assertion: string, actual?: unknown) {
  ctx.recordEvidence({
    type: "assertion",
    status: condition ? "passed" : "failed",
    assertion,
    actual,
  });
  ctx.assert(condition, `${assertion}${actual === undefined ? "" : `. Actual: ${safeJson(actual)}`}`);
}

function trimBase(value: string | undefined, fallback: string) {
  return (value?.trim() || fallback).replace(/\/+$/, "");
}

function flowBase(ctx: FlowContext) {
  return trimBase(ctx.env.OPENWORK_FLOW_BASE_URL, DEFAULT_FLOW_BASE_URL);
}

function denWebBase(ctx: FlowContext) {
  return trimBase(ctx.env.OPENWORK_FLOW_DEN_URL, DEFAULT_DEN_WEB_URL);
}

function joinUrl(base: string, path: string) {
  return `${base}${path.startsWith("/") ? path : `/${path}`}`;
}

function requiredEnv(ctx: FlowContext, name: "OPENWORK_FLOW_EMAIL" | "OPENWORK_FLOW_PASSWORD") {
  const value = ctx.env[name]?.trim() ?? "";
  witness(ctx, value.length > 0, `${name} is set`);
  return value;
}

function authHeaders(ctx: FlowContext) {
  const org = state.org;
  return {
    "content-type": "application/json",
    authorization: `Bearer ${state.denToken}`,
    ...(org ? { "x-openwork-legacy-org-id": org.id } : {}),
  };
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<JsonResult> {
  const response = await fetch(url, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { response, body, text };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function signIn(ctx: FlowContext) {
  const result = await fetchJson(joinUrl(denWebBase(ctx), "/api/auth/sign-in/email"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: flowBase(ctx),
    },
    body: JSON.stringify({
      email: requiredEnv(ctx, "OPENWORK_FLOW_EMAIL"),
      password: requiredEnv(ctx, "OPENWORK_FLOW_PASSWORD"),
    }),
  });
  witness(ctx, result.response.ok, "Email/password sign-in returns HTTP 200", {
    status: result.response.status,
    body: result.body,
  });
  const token = isRecord(result.body) && typeof result.body.token === "string" ? result.body.token.trim() : "";
  witness(ctx, token.length > 0, "Sign-in response includes a bearer token");
  state.denToken = token;
}

function parseOrg(value: unknown): Org | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    slug: typeof value.slug === "string" ? value.slug : null,
    name: typeof value.name === "string" ? value.name : null,
  };
}

async function resolveOrg(ctx: FlowContext) {
  const result = await fetchJson(joinUrl(denWebBase(ctx), "/api/den/v1/me/orgs"), {
    headers: { authorization: `Bearer ${state.denToken}` },
  });
  witness(ctx, result.response.ok, "Signed-in user can read their organizations", {
    status: result.response.status,
    body: result.body,
  });
  const orgs = isRecord(result.body) && Array.isArray(result.body.orgs) ? result.body.orgs : [];
  const activeOrgId = isRecord(result.body) && typeof result.body.activeOrgId === "string" ? result.body.activeOrgId : "";
  const parsed = orgs.flatMap((entry) => {
    const org = parseOrg(entry);
    return org ? [org] : [];
  });
  const selected = parsed.find((org) => org.id === activeOrgId) ?? parsed[0] ?? null;
  witness(ctx, Boolean(selected), "Signed-in user belongs to an organization", result.body);
  state.org = selected;
}

async function setActiveOrg(ctx: FlowContext) {
  const org = state.org;
  if (!org) return;
  const result = await fetchJson(joinUrl(denWebBase(ctx), "/api/den/v1/me/active-organization"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${state.denToken}`,
    },
    body: JSON.stringify({ organizationId: org.id }),
  });
  witness(ctx, result.response.ok, "The eval organization is selected for org-scoped cloud calls", {
    status: result.response.status,
    body: result.body,
  });
}

async function navigateAbsolute(ctx: FlowContext, url: string, timeoutMs = 90_000) {
  await ctx.eval(`location.href = ${JSON.stringify(url)}`);
  await ctx.waitFor("document.readyState === 'complete' || document.body.innerText.length > 0", {
    timeoutMs,
    label: `loaded ${url}`,
  });
}

async function seedBrowserSession(ctx: FlowContext) {
  const org = state.org;
  witness(ctx, Boolean(org), "An organization is available before browser session seeding", org);
  await navigateAbsolute(ctx, flowBase(ctx));
  await ctx.waitFor("window.__OPENWORK_GATEWAY__?.version === 1", {
    timeoutMs: 30_000,
    label: "gateway marker is injected",
  });
  await ctx.eval(`(() => {
    localStorage.setItem("openwork.den.baseUrl", ${JSON.stringify(denWebBase(ctx))});
    localStorage.setItem("openwork.den.authToken", ${JSON.stringify(state.denToken)});
    localStorage.setItem("openwork.den.activeOrgId", ${JSON.stringify(org?.id ?? "")});
    localStorage.setItem("openwork.den.activeOrgSlug", ${JSON.stringify(org?.slug ?? "")});
    localStorage.setItem("openwork.den.activeOrgName", ${JSON.stringify(org?.name ?? "")});
    location.href = ${JSON.stringify(joinUrl(flowBase(ctx), "/session"))};
    return true;
  })()`);
  await ctx.waitFor("document.body.innerText.length > 0", { timeoutMs: 90_000, label: "workspace page rendered" });
}

function parseCloudInstance(body: unknown): CloudInstance | null {
  if (!isRecord(body)) return null;
  if (body.status !== "provisioning" && body.status !== "waking" && body.status !== "ready" && body.status !== "failed") return null;
  return {
    status: body.status,
    url: typeof body.url === "string" ? body.url : null,
    imageVersion: typeof body.imageVersion === "string" ? body.imageVersion : null,
    latestVersion: typeof body.latestVersion === "string" ? body.latestVersion : null,
  };
}

async function readCloudInstance(ctx: FlowContext) {
  const result = await fetchJson(joinUrl(flowBase(ctx), "/api/den/v1/cloud/instance"), {
    headers: authHeaders(ctx),
  });
  witness(ctx, result.response.ok, "Cloud instance status is readable through the gateway Den API", {
    status: result.response.status,
    body: result.body,
  });
  const instance = parseCloudInstance(result.body);
  witness(ctx, Boolean(instance), "Cloud instance payload has status and version fields", result.body);
  state.cloudInstance = instance;
  return instance;
}

function formatVersion(version: string | null) {
  const trimmed = version?.trim() ?? "";
  if (!trimmed) return null;
  const prefix = "openwork-";
  if (!trimmed.toLowerCase().startsWith(prefix)) return trimmed;
  const withoutPrefix = trimmed.slice(prefix.length);
  return withoutPrefix.toLowerCase().startsWith("v") ? withoutPrefix : `v${withoutPrefix}`;
}

function updateAvailable(instance: CloudInstance | null) {
  if (!instance?.latestVersion) return false;
  return instance.imageVersion === null || instance.imageVersion !== instance.latestVersion;
}

function latestLabel(instance: CloudInstance | null) {
  return formatVersion(instance?.latestVersion ?? null) ?? "latest";
}

async function pillText(ctx: FlowContext) {
  const value = await ctx.eval(`document.querySelector('[data-testid="cloud-workspace-pill"]')?.textContent?.trim() ?? ""`);
  return typeof value === "string" ? value : "";
}

async function waitForPillContaining(ctx: FlowContext, text: string, timeoutMs = 90_000) {
  await ctx.waitFor(`(() => {
    const pill = document.querySelector('[data-testid="cloud-workspace-pill"]');
    return pill?.textContent?.includes(${JSON.stringify(text)}) === true;
  })()`, { timeoutMs, label: `cloud workspace pill contains ${text}` });
}

async function openStatusPanel(ctx: FlowContext) {
  await ctx.trustedClick('[data-testid="cloud-workspace-pill"]', { timeoutMs: 10_000 });
  await ctx.waitForText("Version:", { timeoutMs: 10_000 });
}

async function skippedFrame(ctx: FlowContext, claim: string, voiceover: string, reason: string) {
  await ctx.prove(claim, {
    voiceover,
    action: () => {
      ctx.skip(reason);
    },
    assert: () => {
      witness(ctx, true, `Skipped: ${reason}`);
    },
  });
}

function pickWorkspaceId(body: unknown) {
  if (!isRecord(body)) return "";
  const items = Array.isArray(body.items)
    ? body.items
    : Array.isArray(body.workspaces)
      ? body.workspaces
      : Array.isArray(body)
        ? body
        : [];
  const activeId = typeof body.activeId === "string" ? body.activeId : "";
  const active = items.find((item) => isRecord(item) && item.id === activeId);
  const selected = active ?? items.find(isRecord) ?? null;
  return isRecord(selected) && typeof selected.id === "string" ? selected.id : "";
}

async function gatewayInstanceFetch(ctx: FlowContext, path: string, init: RequestInit = {}) {
  return fetchJson(joinUrl(flowBase(ctx), path), {
    ...init,
    headers: {
      ...authHeaders(ctx),
      accept: "application/json",
    },
  });
}

async function clickApprovalIfPresent(ctx: FlowContext) {
  for (const label of ["Allow", "Approve"]) {
    try {
      await ctx.clickText(label, { selector: "button", timeoutMs: 3_000 });
      return;
    } catch {
      // No approval button with this label is visible yet.
    }
  }
}

async function writeWorkspaceMarker(ctx: FlowContext) {
  const workspaces = await gatewayInstanceFetch(ctx, "/workspaces");
  witness(ctx, workspaces.response.ok, "The gateway can list the current workspace", {
    status: workspaces.response.status,
    body: workspaces.body,
  });
  const workspaceId = pickWorkspaceId(workspaces.body);
  witness(ctx, workspaceId.length > 0, "A workspace id is available for the persistence marker", workspaces.body);

  const controller = new AbortController();
  const writePromise = gatewayInstanceFetch(ctx, `/workspace/${encodeURIComponent(workspaceId)}/files/content`, {
    method: "POST",
    signal: controller.signal,
    body: JSON.stringify({
      path: MARKER_PATH,
      content: MARKER_CONTENT,
      force: true,
    }),
  });
  await sleep(1_000);
  await clickApprovalIfPresent(ctx);

  let write: JsonResult;
  try {
    write = await withTimeout(writePromise, 30_000, "Timed out waiting for the workspace marker write");
  } catch (error) {
    controller.abort();
    throw error;
  }
  witness(ctx, write.response.ok, "The workspace marker file is written before the update", {
    status: write.response.status,
    body: write.body,
  });

  const read = await gatewayInstanceFetch(ctx, `/workspace/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(MARKER_PATH)}`);
  witness(ctx, read.response.ok && isRecord(read.body) && read.body.content === MARKER_CONTENT, "The workspace marker file can be read before the update", {
    status: read.response.status,
    body: read.body,
  });
  state.markerWritten = true;
  ctx.output("workspace-marker.json", { workspaceId, path: MARKER_PATH, content: MARKER_CONTENT });
}

async function readWorkspaceMarker(ctx: FlowContext) {
  const workspaces = await gatewayInstanceFetch(ctx, "/workspaces");
  const workspaceId = pickWorkspaceId(workspaces.body);
  witness(ctx, workspaces.response.ok && workspaceId.length > 0, "The workspace is reachable after the update", {
    status: workspaces.response.status,
    body: workspaces.body,
  });
  const read = await gatewayInstanceFetch(ctx, `/workspace/${encodeURIComponent(workspaceId)}/files/content?path=${encodeURIComponent(MARKER_PATH)}`);
  witness(ctx, read.response.ok && isRecord(read.body) && read.body.content === MARKER_CONTENT, "The workspace marker file survives the update", {
    status: read.response.status,
    body: read.body,
  });
}

async function waitForUpdatedWorkspace(ctx: FlowContext) {
  const deadline = Date.now() + 120_000;
  let last: CloudInstance | null = null;
  while (Date.now() < deadline) {
    const instance = await readCloudInstance(ctx);
    last = instance;
    if (instance?.status === "ready" && !updateAvailable(instance)) {
      state.cloudInstance = instance;
      return instance;
    }
    await sleep(5_000);
  }
  witness(ctx, false, "Cloud instance returns to ready on the latest version after update", last);
  return null;
}

export default defineFlow({
  id: FLOW_ID,
  title: "Cloud workspace overlay shows current, stale, updating, persistent, and failed workspace states",
  kind: "user-facing",
  preserveTheme: true,
  requiresApp: true,
  requiredEnv: ["OPENWORK_FLOW_EMAIL", "OPENWORK_FLOW_PASSWORD"],
  steps: [
    {
      name: "Frame 1 — current cloud pill",
      run: async (ctx) => {
        await ctx.prove("Signed-in browser workspace shows a quiet Cloud version pill", {
          voiceover: vo[0],
          action: async () => {
            await signIn(ctx);
            await resolveOrg(ctx);
            await setActiveOrg(ctx);
            await seedBrowserSession(ctx);
            await waitForPillContaining(ctx, "Cloud ·");
          },
          assert: async () => {
            const label = await pillText(ctx);
            witness(ctx, label.startsWith("Cloud · "), "The bottom-right pill shows Cloud plus a version", label);
          },
          screenshot: { name: "cloud-pill-current", requireText: ["Cloud"] },
        });
      },
    },
    {
      name: "Frame 2 — current panel truth",
      run: async (ctx) => {
        await ctx.prove("Opening the pill shows connection, version, latest, backups, and sign out", {
          voiceover: vo[1],
          action: async () => {
            await openStatusPanel(ctx);
          },
          assert: async () => {
            await ctx.expectText("Version:");
            await ctx.expectText("Latest:");
            await ctx.expectText("Backups on");
            await ctx.expectText("Sign out");
          },
          screenshot: { name: "cloud-panel-current", requireText: ["Version:", "Latest:", "Backups on", "Sign out"] },
        });
      },
    },
    {
      name: "Frame 3 — stale update available",
      run: async (ctx) => {
        const instance = await readCloudInstance(ctx);
        state.staleAvailable = updateAvailable(instance);
        if (!state.staleAvailable) {
          await skippedFrame(ctx, "Stale worker state is unavailable in this environment", vo[2], "Cloud worker is already current, so the stale update panel cannot be produced.");
          return;
        }

        await ctx.prove("A stale workspace shows Update available and one Update now action", {
          voiceover: vo[2],
          action: async () => {
            await waitForPillContaining(ctx, "Update available");
            await openStatusPanel(ctx);
          },
          assert: async () => {
            const label = await pillText(ctx);
            witness(ctx, label === "Update available", "The stale pill says Update available", label);
            await ctx.expectText("Update now");
            await ctx.expectText("Takes about 30 seconds. Your files and sessions come along.");
          },
          screenshot: { name: "cloud-panel-stale", requireText: ["Update available", "Update now", "Takes about 30 seconds"] },
        });
      },
    },
    {
      name: "Frame 4 — updating transition",
      run: async (ctx) => {
        if (!state.staleAvailable) {
          await skippedFrame(ctx, "Update click is skipped because no stale worker is available", vo[3], "Cloud worker is already current.");
          return;
        }

        await ctx.prove("Clicking Update now keeps the page visible and changes the pill to updating", {
          voiceover: vo[3],
          action: async () => {
            if (!state.markerWritten) await writeWorkspaceMarker(ctx);
            await ctx.clickText("Update now", { selector: "button", timeoutMs: 10_000 });
            state.updateClicked = true;
          },
          assert: async () => {
            await waitForPillContaining(ctx, "Updating your workspace…", 10_000);
            await ctx.expectNoText("This site can’t be reached");
          },
          screenshot: { name: "cloud-pill-updating", requireText: ["Updating your workspace…"], rejectText: ["This site can’t be reached"] },
        });
      },
    },
    {
      name: "Frame 5 — updated and preserved workspace",
      run: async (ctx) => {
        if (!state.updateClicked) {
          await skippedFrame(ctx, "Updated workspace proof is skipped because no update was requested", vo[4], "Cloud worker was already current or the stale update action was unavailable.");
          return;
        }

        await ctx.prove("After the update, the pill returns to the latest version and the workspace marker file remains", {
          voiceover: vo[4],
          action: async () => {
            const instance = await waitForUpdatedWorkspace(ctx);
            await waitForPillContaining(ctx, `Cloud · ${latestLabel(instance)}`, 120_000);
          },
          assert: async () => {
            await readWorkspaceMarker(ctx);
            const label = await pillText(ctx);
            witness(ctx, label === `Cloud · ${latestLabel(state.cloudInstance)}`, "The pill shows Cloud plus the latest version after update", label);
          },
          screenshot: { name: "cloud-pill-updated", requireText: ["Cloud"] },
        });
      },
    },
    {
      name: "Frame 6 — failed state with exits",
      run: async (ctx) => {
        const instance = await readCloudInstance(ctx);
        if (instance?.status !== "failed") {
          await skippedFrame(ctx, "Failed worker state is unavailable in this environment", vo[5], "Cloud worker is not failed, so the amber recovery panel cannot be produced.");
          return;
        }

        await ctx.prove("A failed workspace shows the amber needs-attention pill with Retry and Sign out", {
          voiceover: vo[5],
          action: async () => {
            await navigateAbsolute(ctx, joinUrl(flowBase(ctx), "/session"));
            await waitForPillContaining(ctx, "Workspace needs attention");
            await openStatusPanel(ctx);
          },
          assert: async () => {
            await ctx.expectText("Workspace needs attention");
            await ctx.expectText("Retry");
            await ctx.expectText("Sign out");
          },
          screenshot: { name: "cloud-panel-failed", requireText: ["Workspace needs attention", "Retry", "Sign out"] },
        });
      },
    },
  ],
});
