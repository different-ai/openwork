import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { browserScript, clickButton, coworker, evalIn, eventually, fill, needs, resolveHost, screenshot, test, waitFor, waitForText } from "@openwork/testkit";
import { expect, onTestFinished } from "vitest";
import { clickCoworkerControl, isolatedFreshStartCoworker } from "../worlds/coworker.ts";

async function openAssignments(app: Awaited<ReturnType<typeof coworker>>): Promise<void> {
  await waitFor(app, () => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    const route = document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route") ?? "";
    if (panel.dataset.collapsed === "false" && route === "overview/assignments") return true;
    if (panel.dataset.collapsed === "true") document.querySelector<HTMLElement>('[data-testid="context-rail-overview"]')?.click();
    else if (panel.dataset.view !== "overview") document.querySelector<HTMLButtonElement>('button[aria-label="Back to activity"]')?.click();
    else if (route !== "overview") document.querySelector<HTMLElement>('[data-testid="panel-back"]')?.click();
    else document.querySelector<HTMLElement>('[data-testid="activity-row-assignments"]')?.click();
    return false;
  }, { timeoutMs: 60_000, label: "Activity assignments" });
}

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker connects local models, persists coworker choices, reconciles memory, and schedules native work"
  : "Open Coworker local-first journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

// Fake credentials must not appear in the inspected screens or app log.
const FAKE_CODEX_REFRESH = "FIXTURE-CODEX-REFRESH-TOKEN-NOT-REAL";
const FAKE_GEMINI_KEY = "FIXTURE-GEMINI-KEY-NOT-REAL";
const FAKE_COPILOT_TOKEN = "FIXTURE-COPILOT-TOKEN-NOT-REAL";
const FIXTURE_SECRETS = [FAKE_CODEX_REFRESH, FAKE_GEMINI_KEY, FAKE_COPILOT_TOKEN];
const STUB_MODELS = ["stub-small", "stub-large"];
const STUB_REPLY = "Hello from the stub server.";

// Loopback model discovery and completions, with a reply gate for queue admission.
async function startStubModelServer(): Promise<{ port: number; chatCalls: () => number; holdReplies: () => void; releaseReplies: () => void; close: () => Promise<void> }> {
  let chatCalls = 0;
  let replyGate: Promise<void> | undefined;
  let releaseReplies = () => {};
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const json = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.method === "GET" && url.pathname === "/api/tags") {
      json(200, { models: STUB_MODELS.map((name) => ({ name, model: name })) });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      json(200, { object: "list", data: STUB_MODELS.map((id) => ({ id, object: "model" })) });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      chatCalls += 1;
      let body = "";
      request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
      request.on("end", async () => {
        let stream = false;
        let model: string = STUB_MODELS[0] ?? "stub";
        try {
          const parsed: unknown = JSON.parse(body);
          if (isRecord(parsed)) {
            stream = parsed.stream === true;
            if (typeof parsed.model === "string") model = parsed.model;
          }
        } catch {
          // An unreadable body still gets the fixed reply.
        }
        await replyGate;
        if (!stream) {
          json(200, { id: "chatcmpl-stub", object: "chat.completion", created: 1, model, choices: [{ index: 0, message: { role: "assistant", content: STUB_REPLY }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 5, total_tokens: 6 } });
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        const chunk = (delta: Record<string, string>, finish: string | null, usage?: Record<string, number>) =>
          `data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
        response.write(chunk({ role: "assistant", content: "" }, null));
        response.write(chunk({ content: STUB_REPLY }, null));
        response.write(chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 5, total_tokens: 6 }));
        response.write("data: [DONE]\n\n");
        response.end();
      });
      return;
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The stub model server did not report a port.");
  return {
    port: address.port,
    chatCalls: () => chatCalls,
    holdReplies: () => { replyGate = new Promise<void>((resolve) => { releaseReplies = resolve; }); },
    releaseReplies: () => { releaseReplies(); replyGate = undefined; },
    close: () => { releaseReplies(); return new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}

function expectNoFixtureSecret(text: string, where: string): void {
  for (const secret of FIXTURE_SECRETS) expect(text, `${where} must never show ${secret}`).not.toContain(secret);
}

// The model is scripted; assignment tools, storage, and receipts use the native path.
const SCRIPTED_PROVIDER = "eval-scripted";
const SCRIPTED_MODEL = "scripted";
const CAR_PROMPT = "Every weekday at 9 remind me to move the car.";
const CAR_REPLY = "Done — every weekday at 9:00 AM I'll remind you to move the car.";
const CAR_TOOL_CALL = {
  name: "coworker_assignment_create",
  arguments: {
    name: "Move the car",
    instructions: "Remind J to move the car for street cleaning, and say which side of the street.",
    schedule: { kind: "weekly", daysOfWeek: [1, 2, 3, 4, 5], hour: 9, minute: 0 },
  },
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { raw += chunk; });
    request.on("end", () => resolve(raw));
    request.on("error", reject);
  });
}

/** Text of the last user message in an OpenAI chat completion request. */
function lastUserText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.messages)) return "";
  const user = [...body.messages].reverse().find((message) => isRecord(message) && message.role === "user");
  if (!isRecord(user)) return "";
  const content = user.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n");
  return "";
}

/** Whether the current turn (after the last user message) already carries a tool result: the second half of a tool-calling turn. */
function hasToolResult(body: unknown): boolean {
  if (!isRecord(body) || !Array.isArray(body.messages)) return false;
  const lastUser = body.messages.map((message) => isRecord(message) && message.role === "user").lastIndexOf(true);
  return body.messages.slice(lastUser + 1).some((message) => isRecord(message) && message.role === "tool");
}

function streamChunks(response: ServerResponse, deltas: Array<Record<string, unknown>>, finish: string): void {
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const base = { id: "chatcmpl-scripted", object: "chat.completion.chunk", created: 1, model: SCRIPTED_MODEL };
  for (const delta of deltas) response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
  response.write("data: [DONE]\n\n");
  response.end();
}

async function startScriptedModel(): Promise<{ baseUrl: string; requests: number }> {
  const state = { baseUrl: "", requests: 0 };
  const server = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: SCRIPTED_MODEL, object: "model" }] }));
      return;
    }
    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      void readBody(request).then((raw) => {
        state.requests += 1;
        let body: unknown = null;
        try { body = JSON.parse(raw); } catch { body = null; }
        const prompt = lastUserText(body);
        if (prompt.includes("move the car") && !hasToolResult(body)) {
          streamChunks(response, [{
            role: "assistant",
            content: null,
            tool_calls: [{ index: 0, id: "call_move_the_car", type: "function", function: { name: CAR_TOOL_CALL.name, arguments: JSON.stringify(CAR_TOOL_CALL.arguments) } }],
          }], "tool_calls");
          return;
        }
        streamChunks(response, [{ role: "assistant" }, { content: prompt.includes("move the car") ? CAR_REPLY : "Okay." }], "stop");
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `scripted model: no route for ${request.method} ${url}` } }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Scripted model did not bind a TCP port.");
  state.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return state;
}

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Cannot serialize an undefined browser value.");
  return serialized.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function clickButtonContaining(app: Awaited<ReturnType<typeof coworker>>, text: string): Promise<void> {
  await waitFor(app, browserScript((text) => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent ?? "").includes(text) && !candidate.disabled);
    if (!button) return false;
    button.scrollIntoView({ block: "center" });
    button.click();
    return true;
  }, [text]), { timeoutMs: 120_000, label: `button containing ${json(text)}` });
}

async function invokeCoworker(app: Awaited<ReturnType<typeof coworker>>, command: string, payload: unknown): Promise<unknown> {
  return evalIn(
    app,
    browserScript((command, payload) => window.__COWORKER__.invoke(command, payload), [command, payload]),
    { awaitPromise: true, timeoutMs: 30_000 },
  );
}

// Select the destructive case explicitly without running the unrelated setup/scheduling tour.
const previewOnly = process.env.OPENWORK_EVAL_COWORKER_CASE === "fresh-start-preview";
const freshStartOnly = previewOnly || process.env.OPENWORK_EVAL_COWORKER_CASE === "fresh-start";

test.skipIf(!enabled)(previewOnly ? "Coworker Fresh start fullscreen preview without an engine or reset" : "Coworker Fresh start relaunches natively without resurrecting history or erasing unrelated credentials", { timeout: 600_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  if (!previewOnly && process.env.OPENWORK_EVAL_COWORKER_RESET_READY !== "confirmed") throw new Error("Destructive native proof is held until the backend owner confirms readiness. No app or reset was started.");
  const model = await startStubModelServer();
  onTestFinished(() => model.close());
  await using fixture = await isolatedFreshStartCoworker(`http://127.0.0.1:${model.port}`, previewOnly);
  const { app, invoke, history, profileDir } = fixture;
  const create = async () => {
    expect(await invoke("coworkers.create", { name: "Juniper", role: "Fixture partner", mission: "Use only the local reset fixture.", avatarColor: "mint", avatarGlasses: "round" })).toMatchObject({ ok: true, result: { slug: "juniper" } });
    expect(await invoke("coworkers.update", { slug: "juniper", patch: { model: "eval-reset/stub-small", modelVariant: "" } })).toMatchObject({ ok: true });
    await evalIn(app, () => { location.reload(); return true; });
    await waitForText(app, "Juniper", { timeoutMs: 120_000 });
  };
  const send = async (message: string) => {
    const calls = model.chatCalls();
    await fill(app, 'textarea[aria-label="Message Juniper"]', message);
    await clickCoworkerControl(app, { testId: "coworker-send" });
    await eventually(() => model.chatCalls(), { within: 90_000, label: "loopback model received the native turn", until: (count) => count > calls });
    await waitFor(app, () => document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready"
      && (document.body.innerText ?? "").includes("Hello from the stub server."), { timeoutMs: 90_000, label: "ordinary native conversation completed" });
  };
  const settings = async () => {
    await clickButtonContaining(app, "OpenWork");
    await clickCoworkerControl(app, { role: "button", label: "Fresh start" });
  };
  const resetPage = () => clickCoworkerControl(app, { testId: "fresh-start-factory-reset" });
  await create();
  if (previewOnly) {
    for (const [name, color, glasses] of [["Piper", "rose", "square"], ["Atlas", "blue", "round"]]) {
      expect(await invoke("coworkers.create", { name, role: "Fixture partner", mission: "Design preview only.", avatarColor: color, avatarGlasses: glasses })).toMatchObject({ ok: true });
    }
    await evalIn(app, () => { location.reload(); return true; });
    await waitForText(app, "Piper", { timeoutMs: 60_000 });
    await settings();
    await resetPage();
    await waitFor(app, () => Boolean(document.querySelector('[data-testid="factory-reset-counts"]')), { timeoutMs: 30_000, label: "native preview validates the isolated reset scope" });
    await fill(app, '[data-testid="factory-reset-confirmation"]', "DEL");
    const image = await screenshot(app);
    const screenshotPath = path.join(profileDir, "fresh-start-fullscreen.png");
    await writeFile(screenshotPath, image.png);
    await evalIn(app, () => { document.querySelector('[data-testid="factory-reset-erase"]')?.scrollIntoView({ block: "end" }); return true; });
    await writeFile(path.join(profileDir, "fresh-start-controls.png"), (await screenshot(app)).png);
    expect(await evalIn(app, () => document.querySelector<HTMLButtonElement>('[data-testid="factory-reset-erase"]')?.disabled)).toBe(true);
    expect(model.chatCalls()).toBe(0);
    evidence.recordAssertionEvidence("Supplementary native UI preview, not reset proof", `Three disposable teammates are shown in the real fullscreen renderer. DEL cannot enable erase. No engine, model request or reset ran. Screenshot: ${screenshotPath}`, true);
    console.log(`Fresh start screenshot: ${screenshotPath}`);
    return;
  }
  const runtime = await invoke("runtime.info");
  const current = await invoke("coworkers.get", { slug: "juniper" });
  if (!isRecord(runtime) || !isRecord(runtime.result) || typeof runtime.result.serverUrl !== "string" || typeof runtime.result.ownerToken !== "string"
    || !isRecord(current) || !isRecord(current.result) || typeof current.result.workspaceId !== "string") throw new Error("Native fixture runtime is unavailable");
  expect(new URL(runtime.result.serverUrl).hostname).toBe("127.0.0.1");
  const engine = `${runtime.result.serverUrl}/workspace/${encodeURIComponent(current.result.workspaceId)}/opencode`;
  const headers = { Authorization: `Bearer ${runtime.result.ownerToken}`, "Content-Type": "application/json" };
  const providers: unknown = await (await fetch(`${engine}/provider`, { headers, signal: AbortSignal.timeout(30_000) })).json();
  expect(providers).toMatchObject({ connected: ["eval-reset"] });
  expect((await fetch(`${engine}/auth/unrelated-fixture`, { method: "PUT", headers, body: JSON.stringify({ type: "api", key: "UNRELATED-ENGINE-FIXTURE-CREDENTIAL" }), signal: AbortSignal.timeout(30_000) })).ok).toBe(true);
   const credentialsBefore = await fixture.credentials();
  expect(JSON.stringify(credentialsBefore)).toContain("UNRELATED-ENGINE-FIXTURE-CREDENTIAL");
  await send("Remember this old conversation for the reset check.");
  fixture.seedUnrelatedHistory();
  const before = history();
  const oldIds = before.filter((row) => row.directory !== path.join(profileDir, "unrelated-project")).map((row) => row.id);
  expect(oldIds.length).toBeGreaterThan(0);
  const coworkersBefore = await invoke("coworkers.list");
  await settings();
  await resetPage();
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="factory-reset-counts"]')), { timeoutMs: 30_000, label: "native reset scope is verified" });
  const image = await screenshot(app);
  await writeFile(path.join(profileDir, "fresh-start-fullscreen.png"), image.png);
  expect(await evalIn(app, () => {
    const rect = document.querySelector('[data-testid="factory-reset-screen"]')?.getBoundingClientRect();
    const rail = document.querySelector('[data-testid="coworker-rail"]');
    return Boolean(rect && rect.width >= innerWidth - 1 && rect.height >= innerHeight - 1 && (!rail || rail.getClientRects().length === 0));
  })).toBe(true);
  for (const confirmation of ["DELET", "delete", "DELETE "]) {
    await fill(app, '[data-testid="factory-reset-confirmation"]', confirmation);
    expect(await evalIn(app, () => document.querySelector<HTMLButtonElement>('[data-testid="factory-reset-erase"]')?.disabled)).toBe(true);
    expect(await invoke("maintenance.factoryReset", { confirmation })).toMatchObject({ ok: false });
  }
  expect(await invoke("maintenance.factoryReset", { confirmation: "DELETE", extra: true })).toMatchObject({ ok: false });
  expect(history()).toEqual(before);
  await clickCoworkerControl(app, { role: "button", label: "Keep my team" });
  expect(await invoke("coworkers.list")).toEqual(coworkersBefore);
  await clickButtonContaining(app, "Back to coworkers");
  await send("Continue the same conversation after cancelling reset.");
  evidence.recordAssertionEvidence("Partial and malformed confirmation cannot erase; Cancel leaves ordinary chat usable", "Native confirmation rejects partial, lowercase, padded and extra-field requests. Team and session identities were unchanged and another loopback-model turn completed.", true);

  // Fixed account-storage fixture, never a real sign-in or remote origin.
  await evalIn(app, browserScript((baseUrl) => {
    localStorage.setItem("coworker.den.session.v1", JSON.stringify({ baseUrl, token: "reset-fixture-session", userName: "Fixture member", userEmail: "fixture@example.test", orgId: "org_reset_fixture", orgName: "Reset fixture" }));
    location.reload();
    return true;
  }, [`http://127.0.0.1:${model.port}`]));
  await waitForText(app, "Juniper", { timeoutMs: 120_000 });
  const replayCoworkersBefore = await invoke("coworkers.list");
  await settings();
  const accountBefore = await evalIn(app, () => localStorage.getItem("coworker.den.session.v1"));
  expect(accountBefore).toContain("reset-fixture-session");
  expect(await invoke("settings.update", { maxParallelLocalRuns: 7 })).toMatchObject({ ok: true });
  await clickCoworkerControl(app, { testId: "fresh-start-replay" });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="onboarding-replay"] [data-testid="onboarding-welcome"]')), { timeoutMs: 30_000, label: "read-only onboarding replay" });
  await clickCoworkerControl(app, { testId: "onboarding-replay-ai" });
  await clickCoworkerControl(app, { testId: "local-mode-continue" });
  await settings();
  await clickCoworkerControl(app, { testId: "fresh-start-defaults" });
  await waitForText(app, "App defaults restored.");
  expect(await invoke("coworkers.list")).toEqual(replayCoworkersBefore);
  expect(history()).toEqual(before);
  expect(await invoke("settings.get")).toMatchObject({ ok: true, result: { maxParallelLocalRuns: 2 } });
   expect(await fixture.credentials()).toEqual(credentialsBefore);
  expect(await evalIn(app, () => localStorage.getItem("coworker.den.session.v1"))).toEqual(accountBefore);
  evidence.recordAssertionEvidence("Replay and Restore defaults preserve existing local identity and history", "The existing team and session IDs remained unchanged after replay and restore defaults. The local account-storage value was preserved.", true);

  await resetPage();
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="factory-reset-counts"]')), { timeoutMs: 30_000, label: "second reset scope is verified" });
  const oldPid = app.handle.pid;
  await fill(app, '[data-testid="factory-reset-confirmation"]', "DELETE");
  // One trusted click only. The bridge, native helper and replacement app own the rest.
  await clickCoworkerControl(app, { testId: "factory-reset-erase" });
  const receiptPath = path.join(profileDir, "owned/electron-userdata-recovery/reset-result-acknowledged.json");
  const receipt = await eventually(async () => {
    let acknowledged = true;
    const text = await readFile(receiptPath, "utf8").catch((error: unknown) => {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
      acknowledged = false;
      return readFile(path.join(path.dirname(receiptPath), "reset-result.json"), "utf8");
    });
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.previousProcesses) || (value.backupPath !== null && typeof value.backupPath !== "string")) throw new Error("Invalid native reset receipt");
    const previousPids = value.previousProcesses.map((entry: unknown) => {
      if (!isRecord(entry) || typeof entry.pid !== "number" || !Number.isSafeInteger(entry.pid) || typeof entry.boot !== "string" || typeof entry.started !== "string") throw new Error("Invalid captured native process identity");
      return entry.pid;
    });
    return { phase: value.phase, recoveryRequired: value.recoveryRequired, previousPids, backupPath: value.backupPath, acknowledged, diagnostics: value.diagnostics };
  }, { within: 180_000, label: "post-exit helper result acknowledged by replacement app", until: (value) => value.phase === "failed" || (value.phase === "completed" && value.acknowledged) });
  expect(receipt, JSON.stringify(receipt)).toMatchObject({ phase: "completed", recoveryRequired: false, acknowledged: true, previousPids: expect.arrayContaining([oldPid]) });
  if (typeof receipt.backupPath !== "string") throw new Error("Completed reset has no backup path");
  for (const pid of receipt.previousPids) expect(() => process.kill(pid, 0)).toThrow();
  await app.reconnect();
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="onboarding-welcome"]')) && !document.querySelector('[data-testid="onboarding-replay"]'), { timeoutMs: 120_000, label: "fresh first-run onboarding after relaunch" });
  expect(await invoke("coworkers.list")).toMatchObject({ ok: true, result: [] });
  expect(await evalIn(app, () => localStorage.getItem("coworker.den.session.v1"))).toBeNull();
  expect(history().map((row) => row.id)).toEqual(["ses_fresh_start_unrelated"]);
  expect(await readFile(path.join(profileDir, "credential-sentinel.json"), "utf8")).toContain("UNRELATED-FIXTURE-CREDENTIAL");
   expect(await fixture.credentials()).toEqual(credentialsBefore);
  expect(JSON.parse(await readFile(path.join(receipt.backupPath, "manifest.json"), "utf8"))).toMatchObject({ historyCount: oldIds.length });
  await create();
  expect(await evalIn(app, () => document.body.innerText)).not.toContain("Remember this old conversation");
  await send("Start a new conversation after the fresh start.");
  for (const id of oldIds) expect(history().map((row) => row.id)).not.toContain(id);
  expect(history().map((row) => row.id)).toContain("ses_fresh_start_unrelated");
   expect(await fixture.credentials()).toEqual(credentialsBefore);
  evidence.recordAssertionEvidence("A real native exit/reset/relaunch returns to onboarding and the same slug works without old history", `The helper receipt at ${receiptPath} confirmed completion after the original PIDs exited. Juniper was recreated, received a deterministic model reply, and did not recover any pre-reset session. The unrelated history and credential sentinel survived.`, true);
});

if (!freshStartOnly) {
test.skipIf(!enabled)("Coworker provider setup without credentials", { timeout: 300_000 }, async ({ evidence, skip }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  await using host = await resolveHost();
  if (host.kind !== "local") skip("needs: a same-host disposable provider fixture; placement is not changed");
  const profileDir = await mkdtemp(path.join(os.tmpdir(), "open-coworker-provider-setup-"));
  onTestFinished(() => rm(profileDir, { recursive: true, force: true }));
  const claudeDir = path.join(profileDir, "claude-config");
  await mkdir(claudeDir, { recursive: true });
  // Presence-only detection without a real credential or Keychain probe.
  await writeFile(path.join(claudeDir, ".credentials.json"), "{}\n", "utf8");
  await using app = await coworker({ name: "provider-setup", host, profileDir, env: {
    CODEX_HOME: path.join(profileDir, "codex-home"), CLAUDE_CONFIG_DIR: claudeDir,
    COWORKER_HOME_DIR: path.join(profileDir, "coworkers"),
    COWORKER_SERVER_CONFIG: path.join(profileDir, "coworker-server.json"),
    OPENWORK_RUNTIME_DB: path.join(profileDir, "coworker-runtime.sqlite"),
    OPENCODE_CONFIG: "", OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ["openai", "anthropic"] }),
    OPENAI_API_KEY: "", ANTHROPIC_API_KEY: "", OPENROUTER_API_KEY: "", GEMINI_API_KEY: "", GOOGLE_API_KEY: "", GOOGLE_GENERATIVE_AI_API_KEY: "", XAI_API_KEY: "",
    OLLAMA_HOST: "127.0.0.1:9", LMSTUDIO_HOST: "127.0.0.1:9",
  } });
  await waitFor(app, () => document.querySelector<HTMLButtonElement>('[data-testid="onboarding-local-choice"]')?.disabled === false, { timeoutMs: 30_000, label: "Use this Mac" });
  await evalIn(app, () => document.querySelector<HTMLButtonElement>('[data-testid="onboarding-local-choice"]')?.click());
  await waitFor(app, () => document.querySelector<HTMLElement>('[data-testid="local-providers"]')?.dataset.loaded === "true", { timeoutMs: 120_000, label: "local provider setup" });
  expect(await evalIn(app, () => ({
    claudeActions: [...(document.querySelector('[data-testid="found-claude-code"]')?.querySelectorAll("button") ?? [])].map((button) => button.textContent?.trim()),
    codexFound: Boolean(document.querySelector('[data-testid="found-codex"]')),
    connected: Boolean(document.querySelector('[data-testid="connected-openai"], [data-testid="connected-anthropic"]')),
    preparationErrors: document.querySelectorAll('[data-testid="local-providers"] > p.text-rose').length,
  }))).toEqual({ claudeActions: ["Add key"], codexFound: false, connected: false, preparationErrors: 0 });
  await clickButton(app, "Set up ChatGPT");
  await waitFor(app, () => document.querySelector<HTMLButtonElement>('[data-testid="add-openai-sign-in"]')?.disabled === false, { timeoutMs: 10_000, label: "ChatGPT sign-in offered without credentials" });
  expect(await evalIn(app, () => ({
    key: document.querySelector<HTMLInputElement>('[data-testid="add-another"] input[type="password"]')?.value,
    waiting: Boolean(document.querySelector('[data-testid="sign-in-wait"]')),
    connected: Boolean(document.querySelector('[data-testid="connected-openai"], [data-testid="connected-anthropic"]')),
  }))).toEqual({ key: "", waiting: false, connected: false });
  // Opening setup must not authorize anything; do not start the sign-in flow.
  await evalIn(app, () => document.querySelector<HTMLButtonElement>('[data-testid="key-form"] button[type="button"]')?.click());
  await waitFor(app, () => !document.querySelector('[data-testid="add-another"]') && Boolean(document.querySelector('[data-testid="chatgpt-setup"]')), { timeoutMs: 10_000, label: "setup closes" });
  expect(await evalIn(app, () => Boolean(document.querySelector('[data-testid="connected-openai"], [data-testid="connected-anthropic"], [data-testid="sign-in-wait"]')))).toBe(false);
  evidence.recordAssertionEvidence("ChatGPT setup is discoverable without credentials", "On first load, detected non-importable Claude credentials did not hide ChatGPT setup or cause a preparation error. Opening and cancelling setup left both providers disconnected, the key empty and authorization unstarted.", true);
});

test.skipIf(!enabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  await using host = await resolveHost();
  // Isolate discovery to fake credentials and loopback servers, not the host's keys.
  const sameMachine = host.kind === "local";
  const codexHome = path.join(host.workspaceRoot, "evals", "fixtures", "open-coworker", "codex-home");
  const stub = sameMachine ? await startStubModelServer() : null;
  const profileDir = sameMachine ? await mkdtemp(path.join(os.tmpdir(), "open-coworker-local-first-")) : undefined;
  if (profileDir) {
    await mkdir(path.join(profileDir, "claude-config"), { recursive: true });
    await writeFile(path.join(profileDir, "claude-config", ".credentials.json"), "{}\n", "utf8");
    const copilotDir = path.join(profileDir, "xdg-config", "github-copilot");
    await mkdir(copilotDir, { recursive: true });
    await writeFile(path.join(copilotDir, "hosts.json"), `${JSON.stringify({ "github.com.attacker.invalid": { user: "fixture", oauth_token: FAKE_COPILOT_TOKEN } }, null, 2)}\n`, "utf8");
  }
  const cleanup = {
    [Symbol.asyncDispose]: async () => {
      await stub?.close();
      if (profileDir) await rm(profileDir, { recursive: true, force: true });
    },
  };
  await using _cleanup = cleanup;
  await using app = await coworker({
    name: "local-first",
    host,
    ...(profileDir ? { profileDir } : {}),
    env: {
      CODEX_HOME: codexHome,
      CLAUDE_CONFIG_DIR: profileDir ? path.join(profileDir, "claude-config") : "",
      GEMINI_API_KEY: FAKE_GEMINI_KEY,
      OPENAI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      OPENROUTER_API_KEY: "",
      GOOGLE_API_KEY: "",
      GOOGLE_GENERATIVE_AI_API_KEY: "",
      XAI_API_KEY: "",
      OLLAMA_HOST: stub ? `127.0.0.1:${stub.port}` : "127.0.0.1:9",
      LMSTUDIO_HOST: "127.0.0.1:9",
    },
  });

  await waitFor(app, () => (document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker"), {
    timeoutMs: 120_000,
    label: "Open Coworker welcome screen",
  });
  await clickButtonContaining(app, "Use this Mac");

  await waitFor(app, () => document.querySelector<HTMLElement>('[data-testid="local-providers"]')?.dataset.loaded === "true", { timeoutMs: 180_000, label: "local mode screen" });
  if (profileDir) {
    expect(await evalIn(app, () => Boolean(document.querySelector('[data-testid="found-copilot"]')))).toBe(false);
    await writeFile(path.join(profileDir, "xdg-config", "github-copilot", "hosts.json"), `${JSON.stringify({ "github.com:Iv1.fixture": { user: "fixture", oauth_token: FAKE_COPILOT_TOKEN } }, null, 2)}\n`, "utf8");
    await evalIn(app, () => document.querySelector<HTMLElement>('[data-testid="local-providers-refresh"]')?.click());
    await waitFor(app, () => Boolean(document.querySelector('[data-testid="found-copilot"]')), { timeoutMs: 60_000, label: "Copilot discovered only after an exact GitHub host sign-in is present" });
    evidence.recordAssertionEvidence(
      "Local sign-in discovery rejects a GitHub lookalike host and accepts GitHub's app-key format",
      "No Copilot row appeared for the lookalike host. After an exact github.com host with its app client suffix was saved, Refresh found the Copilot sign-in.", true,
    );
  }
  const localMode = await waitFor(app, () => {
    if (!document.querySelector('[data-testid="connected-google"]')) return false;
    return {
      found: [...document.querySelectorAll<HTMLLIElement>('[data-testid="found-rows"] > li')].map((row) => row.dataset.testid).sort(),
      connected: [...document.querySelectorAll<HTMLLIElement>('[data-testid="connected-rows"] > li')].map((row) => row.dataset.testid),
      text: document.body.innerText,
    };
  }, { timeoutMs: 120_000, label: "local mode rows" });
  if (!isRecord(localMode) || !Array.isArray(localMode.found) || !Array.isArray(localMode.connected)) throw new Error("Local mode facts were unavailable.");
  expect(localMode.found).toEqual(
    sameMachine ? ["found-claude-code", "found-codex", "found-copilot", "found-server:ollama"] : ["found-codex"],
  );
  expect(localMode.connected).toEqual(["connected-google"]);
  expectNoFixtureSecret(String(localMode.text), "the local mode screen");
  evidence.recordAssertionEvidence(
    "Local discovery is limited to the isolated fixtures",
    "Only the fixture providers appeared, and none of their credentials appeared in the local-mode screen.",
    true,
  );

  // Connect on the Codex row hands the sign-in to the AI service as it is: OpenAI moves under Connected with models.
  await waitFor(app, () => {
    const connect = document.querySelector('[data-testid="found-codex-connect"]');
    if (!(connect instanceof HTMLElement)) return false;
    connect.click();
    return true;
  }, { label: "Connect ChatGPT (signed in with Codex)" });
  const openaiModels = await waitFor(app, () => {
    const row = document.querySelector('[data-testid="connected-openai"]');
    if (!(row instanceof HTMLElement) || document.querySelector('[data-testid="found-codex"]')) return false;
    return row.querySelector('[data-testid="connected-openai-count"]')?.textContent?.trim();
  }, { timeoutMs: 180_000, label: "OpenAI connected from the Codex sign-in" });
  expect(openaiModels).toMatch(/^[1-9]\d* models?$/);
  expect(await evalIn(app, () => Boolean(document.querySelector('[data-testid="chatgpt-setup"]')))).toBe(false);
  expectNoFixtureSecret(String(await evalIn(app, () => document.body.innerText)), "the screen after Connect");
  evidence.recordAssertionEvidence(
    "A discovered sign-in makes its models available without displaying credentials",
    "Connecting Codex moved it to Connected with available models and no fixture secret on screen.",
    true,
  );

  if (sameMachine && stub) {
    // A local model server connects the same way.
    await waitFor(app, () => {
      const connect = document.querySelector('[data-testid="found-server:ollama-connect"]');
      if (!(connect instanceof HTMLElement)) return false;
      connect.click();
      return true;
    }, { label: "Connect Ollama" });
    await waitFor(app, () => document.querySelector('[data-testid="connected-ollama-count"]')?.textContent?.trim() === "2 models" && !document.querySelector('[data-testid="found-server:ollama"]'), { timeoutMs: 180_000, label: "Ollama connected with its two models" });
    // Add another → Custom: a name, an address, an optional key; the server's models are listed before anything is saved.
    await waitFor(app, () => {
      const open = document.querySelector('[data-testid="add-another-open"]');
      if (!(open instanceof HTMLElement)) return false;
      open.click();
      return true;
    }, { label: "Add another" });
    await waitFor(app, () => {
      const custom = [...document.querySelectorAll('[data-testid="add-another"] [data-testid="interaction-option"]')].find((option) => (option.textContent ?? "").includes("Custom"));
      if (!(custom instanceof HTMLElement)) return false;
      custom.click();
      return true;
    }, { label: "Custom (OpenAI-compatible)" });
    await waitFor(app, () => Boolean(document.querySelector('[data-testid="custom-form"]')), { timeoutMs: 30_000, label: "custom server form" });
    await fill(app, '[data-testid="custom-form"] input[aria-label="Name"]', "Stub box");
    await fill(app, '[data-testid="custom-form"] input[aria-label="Address"]', `127.0.0.1:${stub.port}`);
    await clickButton(app, "Check");
    const listedModels = await waitFor(app, () => {
      const select = document.querySelector('[data-testid="custom-start-model"]');
      return select ? [...select.querySelectorAll("option")].map((option) => option.value) : false;
    }, { timeoutMs: 60_000, label: "the stub server's models listed" });
    expect(listedModels).toEqual(STUB_MODELS);
    await evalIn(app, () => {
      const select = document.querySelector<HTMLSelectElement>('[data-testid="custom-start-model"]');
      if (!select) throw new Error("Custom model selector unavailable");
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select, "stub-large");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return select.value;
    });
    await clickButton(app, "Save");
    evidence.recordAssertionEvidence(
      "A custom server lists its actual models before saving",
      "Ollama connected, and the custom-server form returned the fixture's model list before saving Stub box with stub-large selected.",
      true,
    );
  } else {
    await clickButton(app, "Continue");
  }
  await waitFor(app, () => {
    const own = document.querySelector('[data-testid="onboarding-intents-own"]');
    if (!(own instanceof HTMLButtonElement) || own.disabled) return false;
    own.click();
    return true;
  }, { timeoutMs: 60_000, label: "create an individual coworker" });
  await waitForText(app, "Add a coworker", { timeoutMs: 60_000 });
  await fill(app, 'input[placeholder="Scout"]', "Scout");
  await waitFor(app, () => {
    const button = document.querySelector<HTMLButtonElement>('button[aria-label="Violet"]');
    if (!button) return false;
    button.click();
    return true;
  }, { label: "Violet avatar color" });
  await clickButton(app, "Soft square");
  await clickButton(app, "Add coworker", { timeoutMs: 120_000 });

  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-rail"]')), { timeoutMs: 120_000, label: "team rail" });

  await waitFor(app, () => document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready", { timeoutMs: 240_000, label: "Scout ready" });
  await evalIn(app, () => { const button = document.querySelector<HTMLElement>('[data-testid="coworker-composer"] [data-testid="effort-dial-pill"]'); if (!button) throw new Error("Effort dial unavailable"); button.click(); return true; });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="effort-dial-range"]')), { timeoutMs: 10_000, label: "effort control" });
  await evalIn(app, () => { const range = document.querySelector<HTMLElement>('[data-testid="effort-dial-range"]'); if (!range) throw new Error("Effort range unavailable"); range.focus(); return true; });
  await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39 });
  await waitFor(app, async () => { const { result } = await window.__COWORKER__.invoke("coworkers.get", { slug: "scout" }); return typeof result === "object" && result !== null && "effortPreference" in result && result.effortPreference === "thorough"; }, { awaitPromise: true, timeoutMs: 15_000, label: "the dial's stop kept on the record" });
  await evalIn(app, () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true; });
  await waitFor(app, () => !document.querySelector('[data-testid="effort-dial-panel"]'), { timeoutMs: 5_000, label: "the popover closed" });

  // Model choice lives in Coworker settings, reached from the strip's icon (the panel folds first).
  await waitFor(app, () => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    if (panel.dataset.collapsed === "false" && panel.dataset.view === "settings") return true;
    if (panel.dataset.collapsed === "true") document.querySelector<HTMLElement>('[data-testid="context-rail-settings"]')?.click();
    else window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  }, { timeoutMs: 30_000, label: "Coworker settings from the strip" });
  await waitForText(app, "Coworker settings", { timeoutMs: 30_000 });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-model-settings"]')), { timeoutMs: 30_000, label: "AI model section" });
  await waitFor(app, () => {
    const button = document.querySelector('[data-testid="model-picker"] > button');
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  }, { label: "open the AI model picker" });
  await waitFor(app, () => Boolean(document.querySelector('input[aria-label="Search AI models"]')), {
    timeoutMs: 120_000,
    label: "AI model search",
  });
  await fill(app, 'input[aria-label="Search AI models"]', "big-pickle");
  await clickButtonContaining(app, "big-pickle");
  await waitFor(app, () => (document.querySelector('[data-testid="model-picker"]')?.textContent ?? "").includes("Big Pickle"), {
    timeoutMs: 30_000,
    label: "Big Pickle selected in Coworker settings",
  });
  // Read back the person's choice before checking it survives a reload.
  await waitFor(app, async () => { const { result } = await window.__COWORKER__.invoke("coworkers.get", { slug: "scout" }); return typeof result === "object" && result !== null && "model" in result && result.model === "opencode/big-pickle" && "modelChosenBy" in result && result.modelChosenBy === "person"; }, {
    awaitPromise: true,
    timeoutMs: 30_000,
    label: "Scout's record says the person chose Big Pickle",
  });
  const storedCoworker = await invokeCoworker(app, "coworkers.get", { slug: "scout" });
  if (!isRecord(storedCoworker) || !isRecord(storedCoworker.result) || typeof storedCoworker.result.workspaceId !== "string") throw new Error("Scout's workspace was unavailable.");
  const scoutWorkspaceId = storedCoworker.result.workspaceId;

  const secondCoworker = await invokeCoworker(app, "coworkers.create", {
    name: "Nova",
    role: "Research partner",
    mission: "Keep research work moving.",
    avatarColor: "mint",
    avatarGlasses: "round",
  });
  expect(secondCoworker).toMatchObject({ ok: true, result: { slug: "nova" } });
  await evalIn(app, () => { location.reload(); return true; });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-rail"]')), { timeoutMs: 120_000, label: "saved team restored" });
  await waitForText(app, "Nova", { timeoutMs: 120_000 });
  expect(await invokeCoworker(app, "coworkers.get", { slug: "scout" })).toMatchObject({
    ok: true,
    result: {
      name: "Scout",
      avatarColor: "violet",
      avatarGlasses: "square",
      model: "opencode/big-pickle",
      modelChosenBy: "person",
      effortPreference: "thorough",
      workspaceId: scoutWorkspaceId,
    },
  });
  expect(await invokeCoworker(app, "coworkers.get", { slug: "nova" })).toMatchObject({
    ok: true,
    result: { slug: "nova", name: "Nova", role: "Research partner", mission: "Keep research work moving." },
  });
  evidence.recordAssertionEvidence(
    "Coworker creation and person-selected model and effort survive reload",
    "Both coworkers were restored; Scout kept its identity, native workspace, Big Pickle model, person provenance, and Thorough effort.",
    true,
  );
  await clickButtonContaining(app, "Scout");
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Scout"), { timeoutMs: 30_000, label: "Scout discussion view" });

  // Memory is shown as structure. Seed what a working coworker leaves behind: two promoted memories
  // listed in the index (one whose file has since gone) and one file written without an index line.
  await invokeCoworker(app, "coworkers.files.write", {
    slug: "scout",
    path: "memory/long-term/cleaning-day.md",
    content: "# Street cleaning\n\n- Move the car every **Friday** for street cleaning.\n",
  });
  await invokeCoworker(app, "coworkers.files.write", { slug: "scout", path: "memory/long-term/stray.md", content: "Some notes nobody listed.\n" });
  await invokeCoworker(app, "coworkers.files.write", {
    slug: "scout",
    path: "memory/index.md",
    content: "# Long-term memory index\n\nOne line per durable memory in `memory/long-term/`.\n\n- `long-term/cleaning-day.md` — Street cleaning: move car every Friday\n- `long-term/gone.md` — Promoted, then lost\n",
  });
  // The panel closed when the coworker changed; the strip's Memory icon opens that view directly.
  await waitFor(app, () => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    if (panel.dataset.collapsed === "false" && panel.dataset.view === "memory") return true;
    if (panel.dataset.collapsed === "true") document.querySelector<HTMLElement>('[data-testid="context-rail-memory"]')?.click();
    else window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  }, { timeoutMs: 60_000, label: "Memory view" });
  await waitFor(app, () => {
    const tab = document.querySelector('[data-testid="memory-tab-long-term"]');
    if (!(tab instanceof HTMLElement)) return false;
    tab.click();
    return true;
  }, { timeoutMs: 30_000, label: "long-term memory" });
  const memoryRows = await waitFor(app, () => {
    const rows = [...document.querySelectorAll('[data-testid="memory-row"]')];
    if (rows.length !== 3) return false;
    return rows.map((row) => ({
      file: row.getAttribute("data-file"),
      badge: [...row.querySelectorAll("span")].map((span) => span.textContent?.trim() ?? "").find((text) => text === "File missing" || text === "Not in index") ?? "",
    }));
  }, { timeoutMs: 30_000, label: "three long-term memory rows" });
  expect(memoryRows).toEqual([
    { file: "cleaning-day.md", badge: "" },
    { file: "gone.md", badge: "File missing" },
    { file: "stray.md", badge: "Not in index" },
  ]);

  // Selecting a memory renders it; Edit exposes the file, and a saved edit lands on disk.
  await evalIn(app, () => { const row = document.querySelector<HTMLElement>('[data-testid="memory-row"][data-file="cleaning-day.md"]'); if (!row) throw new Error("Cleaning-day memory unavailable"); row.click(); });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="memory-detail"][data-file="cleaning-day.md"] [data-testid="memory-view"]')), { timeoutMs: 30_000, label: "memory detail" });
  await clickButton(app, "Edit");
  await fill(
    app,
    'textarea[aria-label="Street cleaning memory"]',
    "# Street cleaning\n\n- Move the car every **Friday** for street cleaning.\n- The sweeper passes around 9am.\n",
  );
  await clickButton(app, "Save");
  await waitForText(app, "Saved", { timeoutMs: 30_000 });
  const editedMemory = await invokeCoworker(app, "coworkers.files.read", { slug: "scout", path: "memory/long-term/cleaning-day.md" });
  expect(editedMemory).toMatchObject({ ok: true, result: { content: expect.stringContaining("The sweeper passes around 9am.") } });
  await clickButton(app, "View");
  await waitFor(app, () => (document.querySelector('[data-testid="memory-view"]')?.textContent ?? "").includes("The sweeper passes around 9am."), { timeoutMs: 30_000, label: "rendered edit" });

  // Forgetting a memory removes the file and its index line together, after an explicit confirmation.
  await clickButton(app, "Delete…");
  await waitFor(app, () => document.querySelector('[data-testid="memory-delete-confirm"]') !== null, { timeoutMs: 30_000, label: "delete confirmation" });
  await clickButton(app, "Delete memory");
  const afterDelete = await waitFor(app, () => {
    if (document.querySelector('[data-testid="memory-detail"]')) return false;
    const rows = [...document.querySelectorAll('[data-testid="memory-row"]')].map((row) => row.getAttribute("data-file"));
    if (rows.length !== 2) return false;
    return rows;
  }, { timeoutMs: 30_000, label: "memory list after delete" });
  expect(afterDelete).toEqual(["gone.md", "stray.md"]);
  const indexAfterDelete = await invokeCoworker(app, "coworkers.files.read", { slug: "scout", path: "memory/index.md" });
  expect(indexAfterDelete).toEqual({
    ok: true,
    result: { content: "# Long-term memory index\n\nOne line per durable memory in `memory/long-term/`.\n\n- `long-term/gone.md` — Promoted, then lost\n" },
  });
  const deletedFile = await invokeCoworker(app, "coworkers.files.read", { slug: "scout", path: "memory/long-term/cleaning-day.md" });
  expect(deletedFile).toMatchObject({ ok: false, error: expect.stringContaining("ENOENT") });

  // A file the coworker wrote but never listed can be added to the index from its page.
  await evalIn(app, () => { const row = document.querySelector<HTMLElement>('[data-testid="memory-row"][data-file="stray.md"]'); if (!row) throw new Error("Stray memory unavailable"); row.click(); });
  await clickButton(app, "Add to index");
  await waitFor(app, () => {
    const detail = document.querySelector('[data-testid="memory-detail"][data-file="stray.md"]');
    return detail !== null && !(detail.textContent ?? "").includes("Not in index");
  }, { timeoutMs: 30_000, label: "stray memory indexed" });
  const indexAfterAdd = await invokeCoworker(app, "coworkers.files.read", { slug: "scout", path: "memory/index.md" });
  expect(indexAfterAdd).toMatchObject({ ok: true, result: { content: expect.stringContaining("- `long-term/stray.md` — Stray") } });
  evidence.recordAssertionEvidence(
    "Manual memory changes reconcile files and the index",
    "The list identified missing and unindexed files. Editing persisted to disk; confirmed deletion removed only that file and index line, preserving other entries and prose. Add to index listed the stray file.",
    true,
  );
  await evalIn(app, () => { const button = document.querySelector<HTMLButtonElement>('button[aria-label="Back to activity"]'); if (!button) throw new Error("Activity navigation unavailable"); button.click(); });
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-activity-summary"]')), { timeoutMs: 30_000, label: "back on Activity" });

  await clickButtonContaining(app, "OpenWork");
  await waitForText(app, "OpenWork settings", { timeoutMs: 30_000 });
  await clickButton(app, "AI models");
  await waitFor(app, () => document.querySelector<HTMLElement>('[data-testid="this-mac-providers"] [data-testid="local-providers"]')?.dataset.loaded === "true" && Boolean(document.querySelector('[data-testid="connected-openai"]')), { timeoutMs: 120_000, label: "AI models page ready" });
  const modelsPage = String(await evalIn(app, () => document.querySelector<HTMLElement>('[data-testid="openwork-settings"] main')?.innerText ?? ""));
  expectNoFixtureSecret(modelsPage, "the AI models page");
  await clickButtonContaining(app, "Back to coworkers");
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-activity-summary"]')), { timeoutMs: 30_000, label: "back on Activity" });
  // Model choice was verified above. Execute local scheduled work with the
  // already connected fixture so this journey does not depend on a live free model.
  if (sameMachine && stub) {
    expect(await invokeCoworker(app, "coworkers.update", { slug: "scout", patch: { model: "custom-stub-box/stub-large", modelVariant: "" } })).toMatchObject({ ok: true });
  }
  // Scheduled work is added from Activity › Assignments.
  await openAssignments(app);
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-assignments"]')), { timeoutMs: 30_000, label: "the Assignments level" });
  await clickButton(app, "Add assignment");
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="add-responsibility"]')), { timeoutMs: 30_000, label: "add assignment form" });
  await fill(app, 'input[placeholder="Morning competitor report"]', "Local readiness check");
  await fill(app, 'textarea[placeholder="What should happen on every run?"]', "Reply with exactly LOCAL RESPONSIBILITY READY. Do not use tools.");
  await clickButton(app, "Schedule assignment");
  await waitForText(app, "Local readiness check", { timeoutMs: 30_000 });

  const createdResponsibilities = await invokeCoworker(app, "localResponsibilities.list", { slug: "scout" });
  expect(createdResponsibilities).toMatchObject({
    ok: true,
    result: [{
      name: "Local readiness check",
      state: "active",
      schedule: { kind: "daily" },
      latestRun: null,
    }],
  });

  await waitFor(app, () => {
    const menu = document.querySelector('button[aria-label="Actions for Local readiness check"]');
    if (!(menu instanceof HTMLElement)) return false;
    menu.click();
    return true;
  }, { label: "responsibility action menu" });
  await waitFor(app, () => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((candidate) => candidate.textContent?.trim() === "Run now");
    if (!(item instanceof HTMLElement) || (item instanceof HTMLButtonElement && item.disabled)) return false;
    item.click();
    return true;
  }, { label: "Run now menu item" });
  await waitForText(app, "Run started.", { timeoutMs: 30_000 });
  const completedRun = await waitFor(app, async () => {
    const response = await window.__COWORKER__.invoke("localResponsibilities.list", { slug: "scout" });
    if (!response.ok) return false;
    if (!Array.isArray(response.result)) throw new Error("Responsibilities unavailable");
    const item: unknown = response.result[0];
    const run = typeof item === "object" && item !== null && "latestRun" in item ? item.latestRun : null;
    return typeof run === "object" && run !== null && "status" in run && typeof run.status === "string" && ["succeeded", "failed"].includes(run.status) && "threadId" in run && run.threadId ? run : false;
  }, {
    awaitPromise: true,
    timeoutMs: 300_000,
    label: "local responsibility native thread succeeded",
  });
  expect(completedRun).toMatchObject({
    status: "succeeded",
    trigger: "manual",
    threadId: expect.stringMatching(/^ses_/),
    error: "",
  });
  if (sameMachine && stub) expect(completedRun).toMatchObject({ summary: STUB_REPLY });
  evidence.recordAssertionEvidence(
    "Run now completes a stored daily assignment through a native thread",
    JSON.stringify(completedRun),
    true,
  );

  // --- Outcomes live beside the scheduled assignment: a run history with the coworker's own words,
  // and a way to ask the coworker to explain a run without leaving the discussion.
  await openAssignments(app);
  await waitFor(app, () => {
    const toggle = document.querySelector('[data-testid="responsibility-history-toggle"]');
    if (!(toggle instanceof HTMLElement) || !(toggle.textContent ?? "").includes("Done")) return false;
    if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
    return true;
  }, { timeoutMs: 30_000, label: "open the responsibility's details" });
  await waitFor(app, () => {
    const runs = [...document.querySelectorAll('[data-testid="responsibility-run"]')];
    return runs.length === 1 && runs[0].getAttribute("data-outcome") === "succeeded";
  }, { timeoutMs: 30_000, label: "one recorded run in the history" });
  await waitFor(app, () => {
    const explain = document.querySelector('[data-testid="responsibility-explain"]');
    if (!(explain instanceof HTMLElement)) return false;
    explain.click();
    return true;
  }, { timeoutMs: 30_000, label: "Ask Scout to explain" });
  const explainDraft = String(await waitFor(app, () => {
    const composer = document.querySelector('textarea[aria-label="Message Scout"]');
    return composer instanceof HTMLTextAreaElement && composer.value.includes("Local readiness check") ? composer.value : false;
  }, { timeoutMs: 30_000, label: "explain message prefilled in the discussion composer" }));
  expect(explainDraft).toContain('run of your responsibility "Local readiness check". It succeeded.');
  expect(explainDraft).toContain("what the outcome means");
  if (sameMachine && stub) expect(explainDraft).toContain(STUB_REPLY);
  expect(await evalIn(app, () => [...document.querySelectorAll('[data-message-role="user"]')].length)).toBe(0);
  evidence.recordAssertionEvidence(
    "Explain fills a draft without sending it",
    "The successful run appeared in history. Explain filled Scout's composer with its outcome and left the discussion without a user message.",
    true,
  );

  // --- A run limit on this Mac: the second request waits in line and starts by itself.
  await clickButtonContaining(app, "OpenWork");
  await waitForText(app, "OpenWork settings", { timeoutMs: 30_000 });
  await clickButton(app, "AI & local setup");
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="local-runs-card"] [role="radio"][aria-checked="true"]')), { timeoutMs: 30_000, label: "parallel-run limit control" });
  await waitFor(app, () => {
    const one = [...document.querySelectorAll('[data-testid="local-runs-card"] [role="radio"]')].find((radio) => radio.textContent?.trim() === "1");
    if (!(one instanceof HTMLElement) || (one instanceof HTMLButtonElement && one.disabled)) return false;
    one.click();
    return true;
  }, { timeoutMs: 30_000, label: "limit of one run" });
  await waitFor(app, () => [...document.querySelectorAll('[data-testid="local-runs-card"] [role="radio"]')].find((radio) => radio.textContent?.trim() === "1")?.getAttribute("aria-checked") === "true", {
    timeoutMs: 30_000,
    label: "limit saved",
  });
  expect(await invokeCoworker(app, "settings.get", {})).toMatchObject({ ok: true, result: { maxParallelLocalRuns: 1 } });
  await clickButtonContaining(app, "Back to coworkers");
  await waitForText(app, "Local readiness check", { timeoutMs: 30_000 });
  const second = await invokeCoworker(app, "localResponsibilities.create", {
    slug: "scout",
    name: "Second readiness check",
    instructions: "Reply with exactly SECOND RESPONSIBILITY READY. Do not use tools.",
    schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
  });
  // Give the first run something to say so the second visibly waits its turn.
  await invokeCoworker(app, "localResponsibilities.create", {
    slug: "scout",
    name: "Longer readiness check",
    // Long enough that the second run's wait in line outlasts the Assignments list's five-second refresh.
    instructions: "Write sixteen numbered sentences about keeping a team's shared notes tidy, then end with LONGER READINESS READY. Do not use tools.",
    schedule: { kind: "daily", timezone: "UTC", hour: 10, minute: 0 },
  });
  expect(second).toMatchObject({ ok: true, result: { name: "Second readiness check", state: "active" } });
  const listed = await invokeCoworker(app, "localResponsibilities.list", { slug: "scout" });
  if (!isRecord(listed) || !Array.isArray(listed.result)) throw new Error("Local responsibilities were unavailable.");
  const byName = new Map(listed.result.filter(isRecord).map((item) => [String(item.name), String(item.id)]));
  const longerId = byName.get("Longer readiness check");
  const secondId = byName.get("Second readiness check");
  if (!longerId || !secondId) throw new Error(`Responsibilities were not both listed: ${JSON.stringify([...byName.keys()])}`);
  // Hold the fixture's reply until the waiting row is visible, independently of
  // model speed or the Assignments list's refresh interval.
  stub?.holdReplies();
  const admissions = await evalIn(app, browserScript(async (longerId, secondId) => {
    const results = await Promise.all([
      window.__COWORKER__.invoke("localResponsibilities.runNow", { slug: "scout", id: longerId }),
      window.__COWORKER__.invoke("localResponsibilities.runNow", { slug: "scout", id: secondId }),
    ]);
    const list = await window.__COWORKER__.invoke("localResponsibilities.list", { slug: "scout" });
    if (!list.ok) return { results, states: null };
    if (!Array.isArray(list.result)) throw new Error("Responsibilities unavailable");
    const states = list.result.map((item: unknown) => {
      if (typeof item !== "object" || item === null || !("name" in item) || !("latestRun" in item)) throw new Error("Responsibility state unavailable");
      const run = item.latestRun;
      if (run === null || run === undefined) return [item.name, null, null];
      if (typeof run !== "object" || !("status" in run) || !("queuedAt" in run)) throw new Error("Run state unavailable");
      return [item.name, run.status ?? null, run.queuedAt ?? null];
    });
    return { results, states };
  }, [longerId, secondId]), {
    awaitPromise: true,
    timeoutMs: 30_000,
  });
  expect(admissions).toMatchObject({
    results: [
      { ok: true, result: { accepted: true, queued: false, reason: "" } },
      { ok: true, result: { accepted: true, queued: true, reason: "" } },
    ],
  });
  if (!isRecord(admissions) || !Array.isArray(admissions.states)) throw new Error("Queue states were unavailable.");
  // The first run's record exists as soon as admission answers (it may even have finished already);
  // the second is recorded as waiting with the time it was queued.
  expect(admissions.states).toEqual(expect.arrayContaining([
    ["Longer readiness check", expect.stringMatching(/^(running|succeeded)$/), null],
    ["Second readiness check", "queued", expect.any(Number)],
  ]));
  await waitFor(app, () => {
    const row = [...document.querySelectorAll('[data-testid="responsibility-row"]')].find((candidate) => candidate.getAttribute("data-state") === "Queued");
    return row instanceof HTMLElement;
  }, { timeoutMs: 30_000, label: "queued responsibility row" });
  stub?.releaseReplies();
  const drained = await waitFor(app, async () => {
    const response = await window.__COWORKER__.invoke("localResponsibilities.list", { slug: "scout" });
    const items = response.ok ? response.result : [];
    if (!Array.isArray(items)) throw new Error("Responsibilities unavailable");
    const records = items.map((item: unknown) => {
      if (typeof item !== "object" || item === null || !("name" in item) || !("runs" in item) || !Array.isArray(item.runs) || !("latestRun" in item)) throw new Error("Responsibility state unavailable");
      const run = item.latestRun;
      if (typeof run !== "object" || run === null || !("status" in run) || run.status !== "succeeded") return false;
      if (!("queuedAt" in run)) throw new Error("Run queue time unavailable");
      return { name: item.name, runs: item.runs.length, latest: run.status, queuedAt: run.queuedAt };
    });
    return records.every((item) => item !== false) ? records : false;
  }, { awaitPromise: true, timeoutMs: 300_000, label: "both runs succeeded one after another" });
  expect(drained).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "Longer readiness check", runs: 1, latest: "succeeded", queuedAt: null }),
    expect.objectContaining({ name: "Second readiness check", runs: 1, latest: "succeeded", queuedAt: expect.any(Number) }),
  ]));
  expect(await invokeCoworker(app, "localResponsibilities.status", {})).toMatchObject({ ok: true, result: { limit: 1, active: 0, queued: 0 } });
  evidence.recordAssertionEvidence(
    "A parallel-run limit set in Settings makes later runs wait in line and start by themselves",
    "With the stored limit at 1, the first request was admitted and the second queued with a timestamp. Releasing the fixture reply let both succeed exactly once, leaving no active or queued runs.",
    true,
  );

  if (sameMachine && stub) {
    // --- A coworker answers with the custom server, and Disconnect takes it away again.
    await invokeCoworker(app, "coworkers.update", { slug: "scout", patch: { model: "custom-stub-box/stub-large", modelVariant: "" } });
    await clickButtonContaining(app, "Scout");
    await waitFor(app, () => Boolean(document.querySelector('textarea[aria-label="Message Scout"]')), { timeoutMs: 30_000, label: "Scout's discussion composer" });
    await fill(app, 'textarea[aria-label="Message Scout"]', "Say hello");
    await clickButton(app, "Send");
    await waitForText(app, STUB_REPLY, { timeoutMs: 180_000 });
    await waitFor(app, () => [...document.querySelectorAll('[data-testid="coworker-reply-model"]')].some((line) => (line.textContent ?? "").includes("custom-stub-box/stub-large")), { timeoutMs: 30_000, label: "the reply came from the custom server" });
    expect(stub.chatCalls()).toBeGreaterThan(0);
    await clickButtonContaining(app, "OpenWork");
    await waitForText(app, "OpenWork settings", { timeoutMs: 30_000 });
    await clickButton(app, "AI models");
    await waitFor(app, () => {
      const disconnect = document.querySelector('[data-testid="connected-custom-stub-box-disconnect"]');
      if (!(disconnect instanceof HTMLElement)) return false;
      disconnect.click();
      return true;
    }, { timeoutMs: 120_000, label: "Disconnect the custom server" });
    await waitFor(app, () => document.querySelector<HTMLElement>('[data-testid="local-providers"]')?.dataset.loaded === "true" && !document.querySelector('[data-testid="connected-custom-stub-box"]') && Boolean(document.querySelector('[data-testid="connected-openai"]')), { timeoutMs: 120_000, label: "custom server removed" });
    const readiness = await invokeCoworker(app, "localProviders.prepare", {});
    if (!isRecord(readiness) || !isRecord(readiness.result) || !Array.isArray(readiness.result.providers)) throw new Error("Provider readiness was unavailable.");
    const connectedIds = readiness.result.providers.filter(isRecord).filter((provider) => provider.connected === true).map((provider) => provider.id);
    expect(connectedIds).not.toContain("custom-stub-box");
    expect(connectedIds).toContain("openai");
    expect(connectedIds).toContain("ollama");
    evidence.recordAssertionEvidence(
      "A coworker answers with the custom server's model, and Disconnect removes only that server",
      `Set to custom-stub-box/stub-large, Scout's reply ("${STUB_REPLY}") came from the stub server, which recorded the chat request; on the AI models page, Disconnect on Stub box removed it from Connected and from the AI service's connected providers while the Codex-connected OpenAI and the Ollama server stayed connected.`,
      true,
    );
  }

  // Inspect both the visible screen and the local app log for credential disclosure.
  expectNoFixtureSecret(String(await evalIn(app, () => document.body.innerText)), "the final screen");
  const logPath = app.handle.meta?.log;
  if (sameMachine) {
    if (typeof logPath !== "string") throw new Error("The local app log path was unavailable.");
    const log = await readFile(logPath, "utf8");
    expect(log.length).toBeGreaterThan(0);
    expectNoFixtureSecret(log, "the app log");
  }
  evidence.recordAssertionEvidence(
    "Fixture credentials are absent from inspected screens and logs",
    `No fixture credential appeared in local mode, after Connect, in AI models, or on the current screen${sameMachine ? ", and the nonempty app log contained none" : ""}.`,
    true,
  );

  // --- Scheduling from the chat: asked for recurring work, the coworker sets it up itself through
  // its own assignment tool; the conversation shows exactly what it did, and the panel lists it.
  const scripted = await startScriptedModel();
  const runtimeInfo = await invokeCoworker(app, "runtime.info", {});
  if (!isRecord(runtimeInfo) || !isRecord(runtimeInfo.result)) throw new Error("Runtime info was unavailable.");
  const serverUrl = String(runtimeInfo.result.serverUrl);
  const ownerToken = String(runtimeInfo.result.ownerToken);
  // The scripted model joins the engine the way any custom provider does: through the workspace config route.
  const providerPatch = await fetch(`${serverUrl}/workspace/${encodeURIComponent(scoutWorkspaceId)}/config`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      opencode: {
        provider: {
          [SCRIPTED_PROVIDER]: {
            npm: "@ai-sdk/openai-compatible",
            name: "Scripted model",
            options: { baseURL: scripted.baseUrl, apiKey: "eval-scripted-key" },
            models: { [SCRIPTED_MODEL]: { name: "Scripted model", tool_call: true } },
          },
        },
      },
    }),
  });
  expect(providerPatch.status).toBe(200);
  // The config route announces the change; without the desktop's reload listener the engine is reloaded here.
  const engineReload = await fetch(`${serverUrl}/workspace/${encodeURIComponent(scoutWorkspaceId)}/engine/reload`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(engineReload.status).toBe(200);
  expect(await invokeCoworker(app, "coworkers.update", { slug: "scout", patch: { model: `${SCRIPTED_PROVIDER}/${SCRIPTED_MODEL}`, modelVariant: "" } })).toMatchObject({ ok: true });
  await evalIn(app, () => { location.reload(); return true; });
  // Two coworkers exist now; the app opens on the first, so pick Scout as a person would.
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-rail"]')), { timeoutMs: 120_000, label: "team rail after the model change" });
  await clickButtonContaining(app, "Scout");
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Scout"), { timeoutMs: 120_000, label: "Scout discussion view after the model change" });
  await waitFor(app, () => document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready", { timeoutMs: 240_000, label: "Scout ready on the scripted model" });
  await fill(app, 'textarea[aria-label="Message Scout"]', CAR_PROMPT);
  await clickButton(app, "Send");
  await waitFor(app, browserScript((reply) => [...document.querySelectorAll('[data-message-role="assistant"]')].some((message) => (message.textContent ?? "").includes(reply)), [CAR_REPLY]), {
    timeoutMs: 300_000,
    label: "the coworker's confirmation after setting up the assignment",
  });
  await waitFor(app, () => {
    const line = [...document.querySelectorAll('[data-testid="coworker-action-line"]')].find((candidate) => (candidate.textContent ?? "").includes("Created assignment"));
    const summary = line?.querySelector('[data-testid="coworker-work-summary"]');
    const receipt = line?.querySelector('[data-testid="coworker-work-receipt"]');
    if (!(line instanceof HTMLElement) || !(summary instanceof HTMLElement) || !(receipt instanceof HTMLElement) || receipt.dataset.state !== "done") return false;
    return true;
  }, { timeoutMs: 60_000, label: "completed assignment tool receipt" });
  await evalIn(app, () => {
    const summary = [...document.querySelectorAll('[data-testid="coworker-work-summary"]')].find((button) => (button.textContent ?? "").includes("Created assignment"));
    if (summary instanceof HTMLElement && summary.getAttribute("aria-expanded") !== "true") summary.click();
    return true;
  });
  const technical = String(await waitFor(app, () => {
    const step = [...document.querySelectorAll('[data-testid="coworker-work-step"]')].find((candidate) => (candidate.textContent ?? "").includes("Created assignment"));
    const details = step?.querySelector('[data-testid="coworker-work-technical"]');
    return details instanceof HTMLDetailsElement ? details.textContent : false;
  }, { timeoutMs: 30_000, label: "technical details of the assignment step" }));
  expect(technical).toContain("coworker_assignment_create");
  const chatCreated = await invokeCoworker(app, "localResponsibilities.list", { slug: "scout" });
  if (!isRecord(chatCreated) || !Array.isArray(chatCreated.result)) throw new Error("Local responsibilities were unavailable after the chat.");
  const carItem = chatCreated.result.filter(isRecord).find((item) => item.name === "Move the car");
  expect(carItem).toMatchObject({
    name: "Move the car",
    instructions: CAR_TOOL_CALL.arguments.instructions,
    state: "active",
    schedule: { kind: "weekly", daysOfWeek: [1, 2, 3, 4, 5], hour: 9, minute: 0, timezone: expect.any(String) },
    nextDueAt: expect.any(Number),
  });
  if (!isRecord(carItem) || !isRecord(carItem.schedule)) throw new Error("The chat-created assignment was not stored.");
  // No time zone was invented: the coworker's own was filled in.
  expect(carItem.schedule.timezone).toBe(await evalIn(app, () => Intl.DateTimeFormat().resolvedOptions().timeZone));
  // Scheduled work lives in Activity › Assignments; open it from wherever the panel is.
  await openAssignments(app);
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="coworker-assignments"]')), { timeoutMs: 60_000, label: "Assignments for the chat-created assignment" });
  const carRow = String(await waitFor(app, () => {
    const row = [...document.querySelectorAll('[data-testid="responsibility-row"]')].find((candidate) => (candidate.textContent ?? "").includes("Move the car"));
    return row instanceof HTMLElement ? row.innerText.replace(/\s+/g, " ") : false;
  }, { timeoutMs: 60_000, label: "the chat-created assignment in the panel" }));
  expect(carRow).toContain("Move the car");
  expect(scripted.requests).toBeGreaterThan(0);
  evidence.recordAssertionEvidence(
    "A native conversation tool creates recurring work",
    "The scripted provider received the request, the completed receipt identified coworker_assignment_create, and the stored weekday schedule used the app's timezone and appeared in Assignments.",
    true,
  );

  // The interval form persists its window, weekdays, and daily cap.
  await clickButtonContaining(app, "+ Add");
  await waitFor(app, () => Boolean(document.querySelector('[data-testid="add-responsibility"]')), { timeoutMs: 30_000, label: "add responsibility form for the interval" });
  await evalIn(app, () => {
    const cadence = document.querySelector('select[aria-label="Cadence"]');
    if (!cadence) throw new Error("Cadence selector unavailable");
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    setter?.call(cadence, "interval");
    cadence.dispatchEvent(new Event("input", { bubbles: true }));
    cadence.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  });
  await waitFor(app, () => {
    const setNative = (element: HTMLSelectElement | HTMLInputElement, value: string) => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
      setter?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const every = document.querySelector('select[aria-label="Every"]');
    const from = document.querySelector('input[aria-label="From"]');
    const until = document.querySelector('input[aria-label="Until"]');
    const perDay = document.querySelector('select[aria-label="Most runs a day"]');
    if (!(every instanceof HTMLSelectElement) || !(from instanceof HTMLInputElement) || !(until instanceof HTMLInputElement) || !(perDay instanceof HTMLSelectElement)) return false;
    setNative(every, "120");
    setNative(from, "09:00");
    setNative(until, "18:00");
    setNative(perDay, "4");
    // Weekdays only: switch Saturday and Sunday off.
    for (const day of ["Saturday", "Sunday"]) document.querySelector<HTMLButtonElement>('[role="group"][aria-label="Days"] button[aria-label="' + day + '"]')?.click();
    return true;
  }, { timeoutMs: 30_000, label: "interval schedule fields" });
  await fill(app, 'input[placeholder="Morning competitor report"]', "Competitor page");
  await fill(app, 'textarea[placeholder="What should happen on every run?"]', "Reply with exactly COMPETITOR PAGE CHECKED. Do not use tools.");
  await clickButton(app, "Schedule assignment");
  await waitFor(app, () => {
    const row = [...document.querySelectorAll('[data-testid="responsibility-row"]')].find((candidate) => (candidate.textContent ?? "").includes("Competitor page"));
    return row instanceof HTMLElement;
  }, { timeoutMs: 60_000, label: "the interval responsibility in the panel" });
  const intervalStored = await invokeCoworker(app, "localResponsibilities.list", { slug: "scout" });
  if (!isRecord(intervalStored) || !Array.isArray(intervalStored.result)) throw new Error("Local responsibilities were unavailable after the interval.");
  const intervalItem = intervalStored.result.filter(isRecord).find((item) => item.name === "Competitor page");
  expect(intervalItem).toMatchObject({
    state: "active",
    schedule: { kind: "interval", everyMinutes: 120, from: { hour: 9, minute: 0 }, until: { hour: 18, minute: 0 }, daysOfWeek: [1, 2, 3, 4, 5], maxPerDay: 4 },
    nextDueAt: expect.any(Number),
  });
  evidence.recordAssertionEvidence(
    "The interval form stores the selected schedule and daily cap",
    "The created assignment stored a 120-minute interval, 09:00-18:00 window, weekdays, and maximum of four runs per day, with a next due time.",
    true,
  );
});
}
