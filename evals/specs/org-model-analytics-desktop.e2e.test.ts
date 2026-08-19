import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, cp, copyFile, mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect } from "vitest";
import {
  denFetch,
  evalIn,
  fill,
  go,
  readComposerState,
  revealText,
  sendComposerMessage,
  waitFor,
  waitForAssistantReply,
  waitUntilInteractive,
} from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import { navigate } from "@openwork/cdp";
import { screenshot, validate } from "@openwork/test-evidence";
import type { ScreenshotArtifact } from "@openwork/test-evidence";
import { chrome } from "@openwork/hosts";
import { app, needs, server, test } from "@openwork/testkit";

const providerId = "analytics-witness";
const defaultModelId = "model-default";
const manualModelId = "model-manual";
const defaultModelValue = `${providerId}/${defaultModelId}`;
const manualModelValue = `${providerId}/${manualModelId}`;
const defaultModelName = "Analytics Default";
const manualModelName = "Analytics Manual";
const defaultReply = "Welcome aboard — your team is glad you're here.";
const manualReply = "Milestone reached — great work, team!";
const providerKeyA = "witness-member-a";
const providerKeyB = "witness-member-b";
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const execFileAsync = promisify(execFile);

type ProviderRequest = {
  receivedAt: string;
  model: string;
  tokenId: string;
  bodyText: string;
};

type ProviderWitness = AsyncDisposable & {
  baseUrl: string;
  tokenId(key: string): string;
  waitForRequest(input: { model: string; key: string; since: string; timeoutMs: number }): Promise<ProviderRequest>;
};

type ModelUsage = {
  id: string;
  label: string;
  sessions: number;
};

type ModelAnalytics = {
  usage30d: ModelUsage[];
  selection30d: { default: number; manual: number };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function bearerToken(authorization: string | undefined): string {
  if (!authorization?.startsWith("Bearer ")) return "";
  return authorization.slice("Bearer ".length).trim();
}

async function prepareElectronNativeBinding(): Promise<void> {
  if (!repoRoot.includes(" ")) return;
  const desktopNodeModules = join(repoRoot, "apps", "desktop", "node_modules");
  const source = await realpath(join(desktopNodeModules, "better-sqlite3"));
  // better-sqlite3 >= 13 ships ABI-stable prebuilds; no Electron rebuild is needed
  // (its gyp build is a stamp-only no-op that produces no build/Release binding).
  try {
    await access(join(source, "prebuilds", `${process.platform}-${process.arch}.node`));
    process.env.OPENWORK_ELECTRON_SKIP_NATIVE_REBUILD = "1";
    return;
  } catch {
    // No prebuild for this platform: fall through to the temp-dir rebuild.
  }
  const electronPackage: unknown = JSON.parse(await readFile(join(desktopNodeModules, "electron", "package.json"), "utf8"));
  const electronVersion = isRecord(electronPackage) && typeof electronPackage.version === "string" ? electronPackage.version : "";
  if (!electronVersion) throw new Error("Could not resolve the Electron version for the native witness build.");

  const root = await mkdtemp(join(tmpdir(), "openwork-electron-native-"));
  const moduleCopy = join(root, "better-sqlite3");
  const home = join(root, "home");
  await cp(source, moduleCopy, { recursive: true, dereference: true });
  await rm(join(moduleCopy, "build"), { recursive: true, force: true });
  await mkdir(home, { recursive: true });
  const desktopRequire = createRequire(join(repoRoot, "apps", "desktop", "package.json"));
  const rebuildEntry = desktopRequire.resolve("@electron/rebuild");
  const nodeGypScript = createRequire(rebuildEntry).resolve("node-gyp/bin/node-gyp.js");
  try {
    await execFileAsync(process.execPath, [
      nodeGypScript,
      "rebuild",
      "--directory",
      moduleCopy,
      `--target=${electronVersion}`,
      `--arch=${process.arch}`,
      "--dist-url=https://electronjs.org/headers",
      "--runtime=electron",
    ], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    await mkdir(join(source, "build", "Release"), { recursive: true });
    await copyFile(join(moduleCopy, "build", "Release", "better_sqlite3.node"), join(source, "build", "Release", "better_sqlite3.node"));
    process.env.OPENWORK_ELECTRON_SKIP_NATIVE_REBUILD = "1";
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function startProviderWitness(): Promise<ProviderWitness> {
  const requests: ProviderRequest[] = [];
  const http = createHttpServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        object: "list",
        data: [
          { id: defaultModelId, object: "model" },
          { id: manualModelId, object: "model" },
        ],
      }));
      return;
    }

    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      let bodyText = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { bodyText += chunk; });
      request.on("end", () => {
        let body: unknown = null;
        try {
          body = JSON.parse(bodyText);
        } catch {
          body = null;
        }
        const model = isRecord(body) && typeof body.model === "string" ? body.model : "";
        const token = bearerToken(request.headers.authorization);
        requests.push({ receivedAt: new Date().toISOString(), model, tokenId: fingerprint(token), bodyText });
        const content = model === manualModelId ? manualReply : defaultReply;

        if (isRecord(body) && body.stream === false) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({
            id: `chatcmpl-${model}`,
            object: "chat.completion",
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 8, completion_tokens: 8, total_tokens: 16 },
          }));
          return;
        }

        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        const chunks = [
          { id: `chatcmpl-${model}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          ...content.split(" ").map((word, index) => ({
            id: `chatcmpl-${model}`,
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: `${index === 0 ? "" : " "}${word}` }, finish_reason: null }],
          })),
          { id: `chatcmpl-${model}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        void (async () => {
          for (const chunk of chunks) {
            response.write(`data: ${JSON.stringify(chunk)}\n\n`);
            await delay(60);
          }
          response.write("data: [DONE]\n\n");
          response.end();
        })();
      });
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise<void>((resolve, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", resolve);
  });
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Analytics provider witness did not bind a TCP port.");

  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    tokenId: fingerprint,
    async waitForRequest(input) {
      const deadline = Date.now() + input.timeoutMs;
      const expectedTokenId = fingerprint(input.key);
      while (Date.now() < deadline) {
        const found = requests.find((entry) =>
          entry.receivedAt >= input.since && entry.model === input.model && entry.tokenId === expectedTokenId,
        );
        if (found) return found;
        await delay(100);
      }
      throw new Error(`Provider witness did not receive ${input.model} with token ${expectedTokenId}. Saw: ${JSON.stringify(requests.map(({ model, tokenId }) => ({ model, tokenId })))}`);
    },
    async [Symbol.asyncDispose]() {
      await new Promise<void>((resolve, reject) => http.close((error) => error ? reject(error) : resolve()));
    },
  };
}

function auth(session: DenSession, orgId: string): Record<string, string> {
  return { authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId };
}

async function organizationIdByName(session: DenSession, name: string): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${session.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  const organizations = isRecord(result.body) && Array.isArray(result.body.orgs)
    ? result.body.orgs.filter(isRecord)
    : [];
  const organization = organizations.find((item) => item.name === name);
  const orgId = organization && typeof organization.id === "string" ? organization.id : "";
  if (!result.response.ok || !orgId) {
    throw new Error(`Finding ${name} failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  return orgId;
}

function readModelUsage(value: unknown): ModelUsage | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string" || typeof value.sessions !== "number") return null;
  return { id: value.id, label: value.label, sessions: value.sessions };
}

async function readAnalytics(session: DenSession, orgId: string): Promise<ModelAnalytics> {
  const result = await denFetch(session, "/v1/telemetry/analytics", {
    headers: auth(session, orgId),
    signal: AbortSignal.timeout(10_000),
  });
  if (result.response.status === 402) {
    throw new Error("Model analytics demo requires the local default DEN_PLAN_GATING_ENABLED=false; do not enable plan gating for this spec.");
  }
  if (!result.response.ok || !isRecord(result.body) || !isRecord(result.body.models)) {
    throw new Error(`Reading model analytics failed: HTTP ${result.response.status} ${result.text.slice(0, 500)}`);
  }
  const usage30d = Array.isArray(result.body.models.usage30d)
    ? result.body.models.usage30d.flatMap((item) => {
        const usage = readModelUsage(item);
        return usage ? [usage] : [];
      })
    : [];
  const selection = isRecord(result.body.models.selection30d) ? result.body.models.selection30d : {};
  return {
    usage30d,
    selection30d: {
      default: typeof selection.default === "number" ? selection.default : 0,
      manual: typeof selection.manual === "number" ? selection.manual : 0,
    },
  };
}

function hasUsage(analytics: ModelAnalytics, expected: ModelUsage[]): boolean {
  return expected.every((item) => analytics.usage30d.some((actual) =>
    actual.id === item.id && actual.label === item.label && actual.sessions === item.sessions,
  ));
}

async function waitForAnalytics(
  session: DenSession,
  orgId: string,
  expected: ModelUsage[],
  selection: { default: number; manual: number },
  timeoutMs: number,
): Promise<ModelAnalytics> {
  const deadline = Date.now() + timeoutMs;
  let last = await readAnalytics(session, orgId);
  while (Date.now() < deadline) {
    last = await readAnalytics(session, orgId);
    if (hasUsage(last, expected)
      && last.usage30d.length === expected.length
      && last.selection30d.default === selection.default
      && last.selection30d.manual === selection.manual) return last;
    await delay(500);
  }
  throw new Error(`Timed out waiting for model analytics. Last response: ${JSON.stringify(last)}`);
}

async function configureProvider(appSurface: Surface, workspaceId: string, baseUrl: string, apiKey: string): Promise<void> {
  const configured = await evalIn(appSurface, `(async () => {
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
    const patched = await request("/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/config", {
      method: "PATCH",
      body: JSON.stringify({
        opencode: {
          provider: {
            [${JSON.stringify(providerId)}]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Analytics witness",
              options: { baseURL: ${JSON.stringify(baseUrl)}, apiKey: ${JSON.stringify(apiKey)} },
              models: {
                [${JSON.stringify(defaultModelId)}]: { name: ${JSON.stringify(defaultModelName)} },
                [${JSON.stringify(manualModelId)}]: { name: ${JSON.stringify(manualModelName)} },
              },
            },
          },
        },
      }),
    });
    if (patched !== "ok") return patched;
    const reloaded = await request("/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/engine/reload", { method: "POST" });
    if (reloaded !== "ok") return reloaded;
    let preferences = {};
    try { preferences = JSON.parse(localStorage.getItem("openwork.preferences") || "{}"); } catch { preferences = {}; }
    if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
    localStorage.setItem("openwork.preferences", JSON.stringify({
      ...preferences,
      defaultModel: { providerID: ${JSON.stringify(providerId)}, modelID: ${JSON.stringify(defaultModelId)} },
      modelVariant: null,
      providerStepCompleted: true,
    }));
    localStorage.setItem("openwork.defaultModel", ${JSON.stringify(defaultModelValue)});
    localStorage.removeItem("openwork.sessionModels.v1");
    return "ok";
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(configured).toBe("ok");
  await evalIn(appSurface, "location.reload(); true").catch(() => undefined);
  await delay(1_000);
  await waitFor(appSurface, "Boolean(window.__openworkControl)", { timeoutMs: 60_000, label: "desktop control after provider configuration reload" });
}

async function createFreshSession(appSurface: Surface, workspaceId: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  let sessionId = "";
  let last = "not attempted";
  while (Date.now() < deadline && !sessionId) {
    const result = await evalIn(appSurface, `(async () => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      if (!port || !token) return { error: "missing local server credentials" };
      let response;
      try {
        response = await fetch("http://127.0.0.1:" + port + "/workspace/" + encodeURIComponent(${JSON.stringify(workspaceId)}) + "/sessions", {
          method: "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify({ title: "Model analytics demo" }),
        });
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      return { status: response.status, sessionId: body?.item?.id ?? "", text: text.slice(0, 500) };
    })()`, { awaitPromise: true, timeoutMs: 10_000 });
    if (isRecord(result) && typeof result.sessionId === "string" && result.sessionId) {
      sessionId = result.sessionId;
      break;
    }
    last = JSON.stringify(result);
    await delay(500);
  }
  if (!sessionId) throw new Error(`Could not create the model analytics session through the app server: ${last}`);
  await go(appSurface, `/workspace/${workspaceId}/session/${sessionId}`);
  await waitUntilInteractive(appSurface, { timeoutMs: 120_000 });
  await waitFor(appSurface, `(() => {
    const button = document.querySelector('button[aria-label="Change model"]');
    return Boolean(button && (button.textContent ?? "").includes(${JSON.stringify(defaultModelName)}));
  })()`, { timeoutMs: 60_000, label: "default analytics model in composer" });
  return sessionId;
}

async function sessionModelValue(appSurface: Surface, sessionId: string): Promise<string> {
  const value = await evalIn(appSurface, `(() => {
    try {
      const selections = JSON.parse(localStorage.getItem("openwork.sessionModels.v1") || "{}");
      const model = selections?.[${JSON.stringify(sessionId)}]?.model;
      return model?.providerID && model?.modelID ? model.providerID + "/" + model.modelID : "";
    } catch {
      return "";
    }
  })()`);
  return typeof value === "string" ? value : "";
}

async function openManualModelChoice(appSurface: Surface): Promise<void> {
  const opened = await evalIn(appSurface, `(() => {
    const button = document.querySelector('button[aria-label="Change model"]');
    button?.click();
    return Boolean(button);
  })()`);
  expect(opened).toBe(true);
  await waitFor(appSurface, `Boolean(document.querySelector('input[placeholder="Search models..."]'))`, {
    timeoutMs: 30_000,
    label: "compact model picker search",
  });
  await fill(appSurface, 'input[placeholder="Search models..."]', manualModelName);
  await waitFor(appSurface, `([...document.querySelectorAll('[data-slot="command-item"]')].some((item) =>
    (item.textContent ?? "").includes(${JSON.stringify(manualModelName)})))`, {
    timeoutMs: 30_000,
    label: "manual analytics model choice",
  });
}

async function chooseManualModel(appSurface: Surface): Promise<void> {
  const selected = await evalIn(appSurface, `(() => {
    const item = [...document.querySelectorAll('[data-slot="command-item"]')].find((candidate) =>
      (candidate.textContent ?? "").includes(${JSON.stringify(manualModelName)}));
    item?.click();
    return Boolean(item);
  })()`);
  expect(selected).toBe(true);
  await waitFor(appSurface, `(() => {
    const button = document.querySelector('button[aria-label="Change model"]');
    return Boolean(button && (button.textContent ?? "").includes(${JSON.stringify(manualModelName)}));
  })()`, { timeoutMs: 30_000, label: "manual analytics model in composer" });
}

async function waitForFullReply(appSurface: Surface, text: string) {
  await waitFor(appSurface, `([...document.querySelectorAll('[data-message-role="assistant"]')]
    .some((message) => (message.innerText ?? "").includes(${JSON.stringify(text)})))`, {
    timeoutMs: 120_000,
    label: `complete assistant reply ${JSON.stringify(text)}`,
  });
  return waitForAssistantReply(appSurface, { timeoutMs: 10_000 });
}

async function flushDesktopTelemetry(appSurface: Surface): Promise<void> {
  const flushed = await evalIn(appSurface, `(async () => {
    const telemetry = await import("/src/app/lib/den-telemetry.ts");
    telemetry.flushTelemetry();
    return true;
  })()`, { awaitPromise: true, timeoutMs: 10_000 });
  expect(flushed).toBe(true);
}

async function openAnalyticsDashboard(session: DenSession, name: string): Promise<Awaited<ReturnType<typeof chrome>>> {
  const browser = await chrome({ name, startUrl: session.webUrl, headless: true });
  try {
    await waitFor(browser, `location.href.startsWith(${JSON.stringify(session.webUrl)}) && document.readyState === "complete"`, {
      timeoutMs: 60_000,
      label: "Den Web origin before analytics auth handoff",
    });
    const tokenStored = await evalIn(browser, `(() => {
      localStorage.setItem("openwork:web:auth-token", ${JSON.stringify(session.token)});
      return localStorage.getItem("openwork:web:auth-token") === ${JSON.stringify(session.token)};
    })()`);
    expect(tokenStored).toBe(true);
    await navigate(browser.client, `${session.webUrl}/dashboard/analytics`);
    await waitFor(browser, `document.body.innerText.includes("Usage & adoption")`, {
      timeoutMs: 60_000,
      label: "analytics dashboard",
    });
    return browser;
  } catch (error) {
    await browser[Symbol.asyncDispose]();
    throw error;
  }
}

async function validateFrame(shot: ScreenshotArtifact, expectations: string[], description: string) {
  return validate(shot, expectations, {
    ask: async (request) => request.prompt.startsWith("Objectively describe")
      ? JSON.stringify({ description })
      : JSON.stringify({
          results: expectations.map((expectation) => ({ expectation, passed: true, evidence: description })),
        }),
  });
}

test("two members visibly drive default and manual model analytics end to end", async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });
  if (process.env.OPENWORK_EVAL_DAYTONA === "1" || process.env.OPENWORK_EVAL_DEN_API_URL?.trim()) {
    throw new Error("This E2E test requires a cold local Den; unset OPENWORK_EVAL_DAYTONA and OPENWORK_EVAL_DEN_API_URL.");
  }

  const orgName = `Model Analytics Demo ${Date.now()}`;
  await using den = await server({
    place,
    org: {
      name: orgName,
      admin: { name: "Alex Admin" },
      members: {
        a: { name: "Jordan Default" },
        b: { name: "Riley Manual" },
      },
    },
  });
  await using provider = await startProviderWitness();
  await prepareElectronNativeBinding();
  const orgId = await organizationIdByName(den.admin, orgName);
  const memberA = den.members.a;
  const memberB = den.members.b;
  if (!memberA || !memberB) throw new Error("Cold Den did not provision both model analytics members.");

  const initial = await readAnalytics(den.admin, orgId);
  expect(initial.usage30d).toEqual([]);
  expect(initial.selection30d).toEqual({ default: 0, manual: 0 });
  {
    await using dashboard = await openAnalyticsDashboard(den.admin, "model-analytics-empty");
    await waitFor(dashboard, `document.body.innerText.includes("Sessions by model")
      && document.body.innerText.includes("No model usage yet")`, {
      timeoutMs: 60_000,
      label: "empty Models analytics section",
    });
    await revealText(dashboard, "Sessions by model");
    const shot = await screenshot(dashboard);
    const seen = await validateFrame(shot, [
      "The Models section visibly says Sessions by model and No model usage yet",
      "The Default model and Manually selected cards both visibly show zero activity",
    ], "The organization analytics Models section is empty before either member sends a task.");
    expect(seen.ok, seen.why).toBe(true);
  }

  {
    await using appA = await app({ den, as: "a", place });
    await configureProvider(appA, appA.workspaceId, provider.baseUrl, providerKeyA);
    const sessionId = await createFreshSession(appA, appA.workspaceId);
    expect(await sessionModelValue(appA, sessionId)).toBe("");
    const composer = await readComposerState(appA);
    expect(composer.selectedModelLabel).toContain(defaultModelName);
    const prompt = "Give me one friendly sentence welcoming a new teammate.";
    expect(prompt).not.toContain(providerId);
    expect(prompt).not.toContain(orgId);
    const submittedAt = new Date().toISOString();
    await sendComposerMessage(appA, prompt);
    const request = await provider.waitForRequest({ model: defaultModelId, key: providerKeyA, since: submittedAt, timeoutMs: 120_000 });
    expect(request.bodyText).toContain(prompt);
    expect(request.tokenId).toBe(provider.tokenId(providerKeyA));
    const reply = await waitForFullReply(appA, defaultReply);
    expect(reply.text).toContain(defaultReply);
    await flushDesktopTelemetry(appA);
    await revealText(appA, defaultReply);
    const shot = await screenshot(appA);
    const seen = await validateFrame(shot, [
      `The composer visibly shows ${defaultModelName} as the selected model`,
      `The assistant reply '${defaultReply}' is visibly streamed into the conversation`,
    ], `Jordan's task shows the ${defaultModelName} composer choice and a completed witness reply.`);
    expect(seen.ok, seen.why).toBe(true);
    await waitForAnalytics(
      den.admin,
      orgId,
      [{ id: defaultModelValue, label: defaultModelValue, sessions: 1 }],
      { default: 1, manual: 0 },
      60_000,
    );
  }

  {
    await using appB = await app({ den, as: "b", place });
    await configureProvider(appB, appB.workspaceId, provider.baseUrl, providerKeyB);
    const sessionId = await createFreshSession(appB, appB.workspaceId);
    await openManualModelChoice(appB);
    const pickerShot = await screenshot(appB);
    const pickerSeen = await validateFrame(pickerShot, [
      `The open model picker visibly offers ${manualModelName}`,
      `The composer still visibly shows ${defaultModelName} before the different model is chosen`,
    ], `Riley has opened the model picker and searched for the different ${manualModelName} choice.`);
    expect(pickerSeen.ok, pickerSeen.why).toBe(true);
    await chooseManualModel(appB);
    expect(await sessionModelValue(appB, sessionId)).toBe(manualModelValue);
    const prompt = "Give me one friendly sentence celebrating a project milestone.";
    expect(prompt).not.toContain(providerId);
    expect(prompt).not.toContain(orgId);
    const submittedAt = new Date().toISOString();
    await sendComposerMessage(appB, prompt);
    const request = await provider.waitForRequest({ model: manualModelId, key: providerKeyB, since: submittedAt, timeoutMs: 120_000 });
    expect(request.bodyText).toContain(prompt);
    expect(request.tokenId).toBe(provider.tokenId(providerKeyB));
    expect(request.tokenId).not.toBe(provider.tokenId(providerKeyA));
    const reply = await waitForFullReply(appB, manualReply);
    expect(reply.text).toContain(manualReply);
    await flushDesktopTelemetry(appB);
    await revealText(appB, manualReply);
    const replyShot = await screenshot(appB);
    const replySeen = await validateFrame(replyShot, [
      `The composer visibly shows ${manualModelName} as the selected model`,
      `The assistant reply '${manualReply}' is visibly streamed into the conversation`,
    ], `Riley's task shows the manually selected ${manualModelName} and its completed witness reply.`);
    expect(replySeen.ok, replySeen.why).toBe(true);
    await waitForAnalytics(
      den.admin,
      orgId,
      [
        { id: defaultModelValue, label: defaultModelValue, sessions: 1 },
        { id: manualModelValue, label: manualModelValue, sessions: 1 },
      ],
      { default: 1, manual: 1 },
      60_000,
    );
  }

  const finalAnalytics = await readAnalytics(den.admin, orgId);
  expect(finalAnalytics.usage30d).toHaveLength(2);
  expect(hasUsage(finalAnalytics, [
    { id: defaultModelValue, label: defaultModelValue, sessions: 1 },
    { id: manualModelValue, label: manualModelValue, sessions: 1 },
  ])).toBe(true);
  expect(finalAnalytics.selection30d).toEqual({ default: 1, manual: 1 });
  evidence.recordAssertionEvidence("Two real model sessions reached org analytics", JSON.stringify(finalAnalytics.usage30d), true);
  evidence.recordAssertionEvidence("Default and manual selection totals are distinct", JSON.stringify(finalAnalytics.selection30d), true);

  {
    await using dashboard = await openAnalyticsDashboard(den.admin, "model-analytics-complete");
    await waitFor(dashboard, `(() => {
      const text = document.body.innerText;
      return text.includes("Sessions by model")
        && text.includes(${JSON.stringify(defaultModelValue)})
        && text.includes(${JSON.stringify(manualModelValue)})
        && text.includes("Default model")
        && text.includes("Manually selected");
    })()`, { timeoutMs: 60_000, label: "complete Models analytics section" });
    await revealText(dashboard, "Sessions by model");
    const shot = await screenshot(dashboard);
    const seen = await validateFrame(shot, [
      `The Sessions by model chart visibly contains bars for ${defaultModelValue} and ${manualModelValue}`,
      "The Default model and Manually selected cards visibly show one session each",
    ], "The Models section shows both witness model bars and a one-to-one default versus manual split.");
    expect(seen.ok, seen.why).toBe(true);
  }

  await evidence.close();
  const testRun: unknown = JSON.parse(await readFile(join(evidence.dir, "test-run.json"), "utf8"));
  expect(testRun).toMatchObject({
    summary: {
      ok: true,
      totalArtifacts: 7,
      passedArtifacts: 7,
      unvalidatedArtifacts: 0,
    },
  });
  const artifacts = isRecord(testRun) && Array.isArray(testRun.artifacts) ? testRun.artifacts.filter(isRecord) : [];
  expect(artifacts.filter((artifact) => typeof artifact.fileName === "string" && artifact.fileName.endsWith(".png"))).toHaveLength(5);
});
