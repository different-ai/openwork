import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { clickButton, coworker, evalIn, fill, needs, resolveHost, test, waitFor, waitForText } from "@openwork/testkit";
import { expect, onTestFinished } from "vitest";

/**
 * Bring the right panel to one level of Activity — Documents, Workers, or Assignments —
 * from wherever it is: folded, on another view, on the root, or on another level.
 */
async function openActivityLevel(app: Awaited<ReturnType<typeof coworker>>, level: "documents" | "workers" | "assignments"): Promise<void> {
  await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    const route = document.querySelector('[data-testid="panel-content"]')?.getAttribute("data-route") ?? "";
    if (panel.dataset.collapsed === "false" && route === ${JSON.stringify(`overview/${level}`)}) return true;
    if (panel.dataset.collapsed === "true") document.querySelector('[data-testid="context-rail-overview"]')?.click();
    else if (panel.dataset.view !== "overview") document.querySelector('button[aria-label="Back to activity"]')?.click();
    else if (route !== "overview") document.querySelector('[data-testid="panel-back"]')?.click();
    else document.querySelector(${JSON.stringify(`[data-testid="activity-row-${level}"]`)})?.click();
    return false;
  })()`, { timeoutMs: 60_000, label: `Activity › ${level}` });
}


const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker completes local onboarding with what this Mac already has, a calm default sidebar, model choice in settings, native runs with history, a run queue, and scheduling from the chat"
  : "Open Coworker local-first journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

// Every fixture value is plainly fake; the journey proves none of them ever shows up anywhere a person or a log could read.
const FAKE_CODEX_REFRESH = "FIXTURE-CODEX-REFRESH-TOKEN-NOT-REAL";
const FAKE_GEMINI_KEY = "FIXTURE-GEMINI-KEY-NOT-REAL";
const FAKE_COPILOT_TOKEN = "FIXTURE-COPILOT-TOKEN-NOT-REAL";
const FIXTURE_SECRETS = [FAKE_CODEX_REFRESH, FAKE_GEMINI_KEY, FAKE_COPILOT_TOKEN];
const STUB_MODELS = ["stub-small", "stub-large"];
const STUB_REPLY = "Hello from the stub server.";

/**
 * A local model server the way Ollama and any OpenAI-compatible server answer:
 * a tags list, a models list, and streamed chat completions with one fixed
 * reply. Only reachable when the app runs on this machine.
 */
async function startStubModelServer(): Promise<{ port: number; chatCalls: () => number; close: () => Promise<void> }> {
  let chatCalls = 0;
  const server = http.createServer((request, response) => {
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
      request.on("end", () => {
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function expectNoFixtureSecret(text: string, where: string): void {
  for (const secret of FIXTURE_SECRETS) expect(text, `${where} must never show ${secret}`).not.toContain(secret);
}

/**
 * A deterministic OpenAI-compatible model for the scheduling part of the
 * journey: asked for recurring work, it answers with one call to the
 * coworker's own assignment tool, then confirms in a sentence once the tool
 * has answered. Everything else — the tool server, the store, the receipt, the
 * panel — is the real product path.
 */
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
  await waitFor(app, `(() => {
    const button = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent ?? "").includes(${json(text)}) && !candidate.disabled);
    if (!button) return false;
    button.scrollIntoView({ block: "center" });
    button.click();
    return true;
  })()`, { timeoutMs: 120_000, label: `button containing ${json(text)}` });
}

async function invokeCoworker(app: Awaited<ReturnType<typeof coworker>>, command: string, payload: unknown): Promise<unknown> {
  return evalIn(
    app,
    `window.__COWORKER__.invoke(${json(command)}, ${json(payload)})`,
    { awaitPromise: true, timeoutMs: 30_000 },
  );
}

test.skipIf(!enabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });
  await using host = await resolveHost();
  // Fixtures the app finds on "this Mac": a Codex sign-in (a committed fixture the app reads through
  // CODEX_HOME, so it works wherever the app runs), a Google key in the environment, and — only when the
  // app runs on this machine — a Copilot sign-in under the profile's XDG config plus a stub model server
  // standing in for Ollama. Every other key the AI service would read is blanked so the host's own keys
  // never leak into what the journey asserts.
  const sameMachine = host.kind === "local";
  const codexHome = path.join(host.workspaceRoot, "evals", "fixtures", "open-coworker", "codex-home");
  const stub = sameMachine ? await startStubModelServer() : null;
  const profileDir = sameMachine ? await mkdtemp(path.join(os.tmpdir(), "open-coworker-local-first-")) : undefined;
  if (profileDir) {
    const copilotDir = path.join(profileDir, "xdg-config", "github-copilot");
    await mkdir(copilotDir, { recursive: true });
    await writeFile(path.join(copilotDir, "hosts.json"), `${JSON.stringify({ "github.com": { user: "fixture", oauth_token: FAKE_COPILOT_TOKEN } }, null, 2)}\n`, "utf8");
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

  await waitFor(app, `(document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker")`, {
    timeoutMs: 120_000,
    label: "Open Coworker welcome screen",
  });
  const welcomeText = await evalIn(app, "document.body.innerText");
  expect(welcomeText).toContain("Continue with OpenWork");
  expect(welcomeText).toContain("Use this Mac");
  const welcomeLayout = await evalIn(app, `(() => {
    const launcher = document.querySelector('[data-testid="onboarding-launcher"]');
    const cloud = document.querySelector('[data-testid="onboarding-cloud-choice"]');
    const local = document.querySelector('[data-testid="onboarding-local-choice"]');
    if (!launcher || !cloud || !local) return null;
    const launcherRect = launcher.getBoundingClientRect();
    const cloudRect = cloud.getBoundingClientRect();
    const localRect = local.getBoundingClientRect();
    return {
      launcherCenterOffset: Math.abs((launcherRect.left + launcherRect.width / 2) - window.innerWidth / 2),
      launcherWidth: launcherRect.width,
      cloudTop: cloudRect.top,
      localTop: localRect.top,
      cloudWidth: cloudRect.width,
      localWidth: localRect.width,
    };
  })()`);
  expect(welcomeLayout).toMatchObject({
    launcherCenterOffset: expect.any(Number),
    launcherWidth: expect.any(Number),
    cloudTop: expect.any(Number),
    localTop: expect.any(Number),
    cloudWidth: expect.any(Number),
    localWidth: expect.any(Number),
  });
  if (!isRecord(welcomeLayout)) throw new Error("Open Coworker welcome layout was unavailable.");
  for (const key of ["launcherCenterOffset", "launcherWidth", "cloudTop", "localTop", "cloudWidth", "localWidth"]) {
    if (typeof welcomeLayout[key] !== "number") throw new Error(`Open Coworker welcome layout did not report ${key}.`);
  }
  expect(welcomeLayout.launcherCenterOffset as number).toBeLessThan(4);
  expect(welcomeLayout.launcherWidth as number).toBeGreaterThan(420);
  expect(welcomeLayout.launcherWidth as number).toBeLessThanOrEqual(680);
  expect(welcomeLayout.localTop as number).toBeGreaterThan(welcomeLayout.cloudTop as number);
  expect(Math.abs((welcomeLayout.cloudWidth as number) - (welcomeLayout.localWidth as number))).toBeLessThan(2);
  const brandGaze = await evalIn(app, `(() => {
    const mark = document.querySelector('svg[aria-label="Open Coworker"].coworker-mark');
    if (!mark) return null;
    const bounds = mark.getBoundingClientRect();
    // The gaze follows the pointer synchronously, so read it in the same tick as the synthetic
    // move: a real mouse crossing the window cannot slip in between.
    window.dispatchEvent(new PointerEvent("pointermove", {
      clientX: window.innerWidth - 2,
      clientY: bounds.top + bounds.height / 2,
    }));
    const pointerLayer = mark.querySelector(".coworker-mark__pointer-gaze");
    return {
      whiteTile: mark.querySelector('rect[fill="#f7f8fa"]') !== null,
      blackOutline: mark.querySelector('path[fill="none"][stroke="#11151d"]') !== null,
      rearShell: mark.querySelector('path[fill="#d9dde4"][stroke="#aeb5c0"]') !== null,
      blueFill: mark.querySelector('[fill="#5b8dff"]') !== null,
      hasPointerLayer: pointerLayer !== null,
      lookX: Number.parseFloat(mark.style.getPropertyValue("--avatar-look-x")),
      lookY: Number.parseFloat(mark.style.getPropertyValue("--avatar-look-y")),
    };
  })()`, { timeoutMs: 30_000 });
  // The welcome mark is the bare, flat white speech bubble: no app-icon tile and no depth layer.
  expect(brandGaze).toMatchObject({
    whiteTile: false,
    blackOutline: true,
    rearShell: false,
    blueFill: false,
    hasPointerLayer: true,
    lookX: expect.any(Number),
    lookY: expect.any(Number),
  });
  if (!isRecord(brandGaze) || typeof brandGaze.lookX !== "number" || typeof brandGaze.lookY !== "number") {
    throw new Error("Open Coworker brand gaze was unavailable.");
  }
  expect(brandGaze.lookX).toBeGreaterThan(0);
  expect(brandGaze.lookX).toBeLessThanOrEqual(2);
  expect(Math.abs(brandGaze.lookY)).toBeLessThanOrEqual(1.5);
  // The mark fronts the app icon's composition: one charcoal card behind it. Two visiting coworkers
  // (pale mint, pale violet) slide out once during the welcome and hide again; by the time the
  // journey looks, the stack rests as the icon does, keeps one fixed box, and takes no pointer
  // events, so it never disturbs the onboarding controls.
  const mascot = await waitFor(app, `(() => {
    const stack = document.querySelector('[data-testid="onboarding-mascot"]');
    if (!(stack instanceof HTMLElement) || stack.dataset.phase !== "rest") return false;
    const r = stack.getBoundingClientRect();
    const visitors = [...stack.querySelectorAll('[data-testid="onboarding-mascot-visitor"]')];
    return {
      phase: stack.dataset.phase,
      visitorsState: stack.dataset.visitors,
      cards: stack.querySelectorAll('[data-testid="onboarding-mascot-card"]').length,
      frontLabel: stack.querySelector('.mascot-stack__front svg')?.getAttribute("aria-label") ?? "",
      frontBare: Boolean(stack.querySelector('.mascot-stack__front .coworker-mark--bare')),
      visitors: visitors.map((visitor) => [visitor.dataset.color, visitor.dataset.glasses, visitor.getAttribute("aria-hidden"), getComputedStyle(visitor).visibility].join(":")),
      box: [Math.round(r.width), Math.round(r.height)].join("x"),
      pointerEvents: getComputedStyle(stack).pointerEvents,
      gazing: stack.classList.contains("is-gazing"),
    };
  })()`, { timeoutMs: 30_000, label: "mascot at rest after its welcome" });
  expect(mascot).toMatchObject({
    phase: "rest",
    visitorsState: "hidden",
    cards: 1,
    frontLabel: "Open Coworker",
    frontBare: true,
    visitors: ["mint:round:true:hidden", "violet:round:true:hidden"],
    pointerEvents: "none",
    gazing: true,
  });
  if (!isRecord(mascot)) throw new Error("Mascot facts were unavailable.");
  const mascotBox = mascot.box;
  expect(await evalIn(app, `(() => { const r = document.querySelector('[data-testid="onboarding-mascot"]').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)].join("x"); })()`)).toBe(mascotBox);
  // A visitor peeks every so often and blinks for a fraction of a second while peeking; the page
  // records that instant itself (class and data-attribute changes on the stack) so the wait does
  // not depend on a poll landing inside it.
  await evalIn(app, `(() => {
    const stack = document.querySelector('[data-testid="onboarding-mascot"]');
    if (!(stack instanceof HTMLElement)) return false;
    window.__soloPeek = null;
    const capture = () => {
      if (window.__soloPeek) return;
      const side = stack.dataset.ambientVisitor;
      if ((side !== "left" && side !== "right") || stack.dataset.ambientStage !== "peeking") return;
      if (!stack.classList.contains(side + "-blinking")) return;
      const visitors = [...stack.querySelectorAll('[data-testid="onboarding-mascot-visitor"]')];
      const visible = visitors.filter((visitor) => getComputedStyle(visitor).visibility === "visible");
      const active = visitors.filter((visitor) => visitor.getAttribute("data-ambient-active") === "true");
      const activeAvatar = active[0]?.querySelector(".coworker-avatar");
      const rect = stack.getBoundingClientRect();
      window.__soloPeek = {
        side,
        stage: stack.dataset.ambientStage,
        visitorsState: stack.dataset.visitors,
        visibleVisitors: visible.length,
        activeVisitors: active.length,
        helloAnimation: activeAvatar ? getComputedStyle(activeAvatar).animationName : "",
        box: [Math.round(rect.width), Math.round(rect.height)].join("x"),
      };
    };
    const observer = new MutationObserver(capture);
    observer.observe(stack, { attributes: true, subtree: true });
    window.__soloPeekObserver = observer;
    capture();
    return true;
  })()`);
  const soloPeek = await waitFor(app, `window.__soloPeek ?? false`, { timeoutMs: 40_000, label: "one patient onboarding visitor peeking and blinking" });
  await evalIn(app, `(() => { window.__soloPeekObserver?.disconnect(); return true; })()`);
  expect(soloPeek).toMatchObject({
    side: expect.stringMatching(/^(left|right)$/),
    stage: "peeking",
    visitorsState: "peeking",
    visibleVisitors: 1,
    activeVisitors: 1,
    helloAnimation: "mascot-peek-hello",
    box: mascotBox,
  });
  await waitFor(app, `(() => {
    const stack = document.querySelector('[data-testid="onboarding-mascot"]');
    if (!(stack instanceof HTMLElement)) return false;
    window.dispatchEvent(new PointerEvent("pointermove", { clientX: 12, clientY: 12 }));
    const hidden = [...stack.querySelectorAll('[data-testid="onboarding-mascot-visitor"]')]
      .every((visitor) => getComputedStyle(visitor).visibility === "hidden");
    return stack.dataset.ambientVisitor === "none" && stack.dataset.ambientStage === "waiting" && hidden;
  })()`, { label: "the solo onboarding peek dismissing on activity" });
  evidence.recordAssertionEvidence(
    "First run presents a restrained pointer-aware mark whose waiting coworkers check in one at a time",
    "The fixed-size launch mascot completed its opening welcome, then after an idle pause exactly one rear coworker peeked out, lifted less than a pixel, and blinked while the other stayed hidden. Pointer activity tucked it away immediately without moving the onboarding layout.",
    true,
  );

  await clickButtonContaining(app, "Use this Mac");

  // --- Local mode: exactly what this Mac has, one Connect per row, the free model, and Add another.
  await waitFor(app, `document.querySelector('[data-testid="local-providers"]')?.dataset.loaded === "true"`, { timeoutMs: 180_000, label: "local mode screen" });
  const readRows = `(selector) => [...document.querySelectorAll(selector + ' > li')].map((row) => ({
    id: row.dataset.testid,
    title: row.querySelector("span.block")?.textContent?.trim() ?? "",
    line: row.querySelector('[data-testid$="-line"]')?.textContent?.trim() ?? "",
    actions: [...row.querySelectorAll("button")].map((button) => button.textContent?.trim()),
  }))`;
  const localMode = await waitFor(app, `(() => {
    const read = ${readRows};
    const found = read('[data-testid="found-rows"]');
    if (!document.querySelector('[data-testid="connected-google"]')) return false;
    return {
      title: document.querySelector('[data-testid="local-mode"] h1')?.textContent?.trim(),
      recommended: document.querySelector('[data-testid="local-mode-recommended"]')?.innerText ?? "",
      found,
      connected: read('[data-testid="connected-rows"]'),
      free: document.querySelector('[data-testid="free-model-row"]')?.innerText ?? "",
      freeChoice: document.querySelector('[data-testid="free-model-choose"]')?.textContent?.trim(),
      shared: document.querySelector('[data-testid="local-mode-shared"]')?.textContent?.trim(),
      text: document.body.innerText,
    };
  })()`, { timeoutMs: 120_000, label: "local mode rows" });
  if (!isRecord(localMode) || !Array.isArray(localMode.found) || !Array.isArray(localMode.connected)) throw new Error("Local mode facts were unavailable.");
  expect(localMode.title).toBe("AI on this Mac");
  expect(String(localMode.recommended)).toContain("Continue with OpenWork for your organization's models and tools.");
  // Exactly the fixtures, nothing about providers that are absent, and no Connect for what cannot connect here.
  expect(localMode.found.map((row) => isRecord(row) ? row.id : row)).toEqual(
    sameMachine ? ["found-codex", "found-copilot", "found-server:ollama"] : ["found-codex"],
  );
  expect(localMode.found[0]).toMatchObject({ title: "ChatGPT (signed in with Codex)", line: "Uses your ChatGPT subscription for coworkers on this Mac.", actions: ["Connect"] });
  if (sameMachine) {
    expect(localMode.found[1]).toMatchObject({ title: "GitHub Copilot (signed in on this Mac)", actions: ["Connect"] });
    expect(localMode.found[2]).toMatchObject({ title: "Ollama (running on this Mac)", line: "2 models ready. Uses them for coworkers on this Mac; no account needed.", actions: ["Connect"] });
  }
  expect(localMode.connected.map((row) => isRecord(row) ? [row.id, row.line] : row)).toEqual([["connected-google", "From GEMINI_API_KEY in your environment."]]);
  expect(localMode.connected[0]).toMatchObject({ actions: ["Start with this"] });
  expect(String(localMode.free)).toContain("A free model is ready now");
  expect(String(localMode.free)).toContain("No setup, no account");
  expect(localMode.freeChoice).toBe("Start with this");
  expect(localMode.shared).toBe("Sign-ins and keys are shared with OpenWork Desktop and OpenCode on this Mac.");
  const localModeText = String(localMode.text);
  for (const absent of ["Claude", "Anthropic", "LM Studio", "OpenRouter", "xAI"]) expect(localModeText, `${absent} is not on this Mac`).not.toContain(absent);
  for (const banned of ["engine", "provider id", "OAuth", "auth.json", "base URL", "SDK"]) expect(localModeText.toLowerCase(), `plain words only: ${banned}`).not.toContain(banned.toLowerCase());
  expectNoFixtureSecret(localModeText, "the local mode screen");
  // The recommended line is dismissible for the session, not nagging.
  await waitFor(app, `(() => {
    const dismiss = document.querySelector('[data-testid="local-mode-recommended"] button[aria-label="Dismiss"]');
    if (!(dismiss instanceof HTMLElement)) return false;
    dismiss.click();
    return true;
  })()`, { label: "dismiss the recommended line" });
  await waitFor(app, `!document.querySelector('[data-testid="local-mode-recommended"]')`, { timeoutMs: 10_000, label: "recommended line gone" });
  evidence.recordAssertionEvidence(
    "Use this Mac shows exactly what was found, with one Connect per row and the free model ready",
    `After Use this Mac, the AI on this Mac screen listed exactly ${sameMachine ? "the Codex sign-in, the Copilot sign-in, and the stub Ollama server" : "the Codex sign-in"} under Found on this Mac with one plain line and a Connect each, the Google key from the environment under Connected, the free model row with Start with this, one line saying sign-ins are shared with OpenWork Desktop and OpenCode, and nothing about Claude, LM Studio, or other providers that were not there; no banned word and no fixture secret appeared, and the recommended line dismissed for the session.`,
    true,
  );

  // Connect on the Codex row hands the sign-in to the AI service as it is: OpenAI moves under Connected with models.
  await waitFor(app, `(() => {
    const connect = document.querySelector('[data-testid="found-codex-connect"]');
    if (!(connect instanceof HTMLElement)) return false;
    connect.click();
    return true;
  })()`, { label: "Connect ChatGPT (signed in with Codex)" });
  const openaiRow = await waitFor(app, `(() => {
    const row = document.querySelector('[data-testid="connected-openai"]');
    if (!(row instanceof HTMLElement) || document.querySelector('[data-testid="found-codex"]')) return false;
    return {
      line: row.querySelector('[data-testid="connected-openai-line"]')?.textContent?.trim(),
      count: row.querySelector('[data-testid="connected-openai-count"]')?.textContent?.trim(),
      actions: [...row.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    };
  })()`, { timeoutMs: 180_000, label: "OpenAI connected from the Codex sign-in" });
  expect(openaiRow).toMatchObject({ line: "Your ChatGPT subscription, signed in with Codex.", count: expect.stringMatching(/^[1-9]\d* models?$/), actions: ["Start with this", "Disconnect"] });
  expectNoFixtureSecret(String(await evalIn(app, "document.body.innerText")), "the screen after Connect");
  evidence.recordAssertionEvidence(
    "Connect on a found sign-in takes one step and the provider's models become available on this Mac",
    `Connect on ChatGPT (signed in with Codex) moved OpenAI under Connected with its model count and a Disconnect, and the Codex row left Found on this Mac; the Codex sign-in file's tokens never appeared on screen.`,
    true,
  );

  if (sameMachine && stub) {
    // A local model server connects the same way.
    await waitFor(app, `(() => {
      const connect = document.querySelector('[data-testid="found-server:ollama-connect"]');
      if (!(connect instanceof HTMLElement)) return false;
      connect.click();
      return true;
    })()`, { label: "Connect Ollama" });
    await waitFor(app, `document.querySelector('[data-testid="connected-ollama-count"]')?.textContent?.trim() === "2 models" && !document.querySelector('[data-testid="found-server:ollama"]')`, { timeoutMs: 180_000, label: "Ollama connected with its two models" });
    // Add another → Custom: a name, an address, an optional key; the server's models are listed before anything is saved.
    await waitFor(app, `(() => {
      const open = document.querySelector('[data-testid="add-another-open"]');
      if (!(open instanceof HTMLElement)) return false;
      open.click();
      return true;
    })()`, { label: "Add another" });
    const addable = await waitFor(app, `(() => {
      const options = [...document.querySelectorAll('[data-testid="add-another"] [data-testid="interaction-option"]')];
      return options.length > 0 ? options.map((option) => option.textContent?.replace(/^[A-Z]/, "").trim()) : false;
    })()`, { timeoutMs: 30_000, label: "Add another choices" });
    if (!Array.isArray(addable)) throw new Error("Add another choices were unavailable.");
    expect(addable.length).toBeGreaterThan(2);
    expect(String(addable[addable.length - 1])).toContain("Custom (OpenAI-compatible)");
    await waitFor(app, `(() => {
      const custom = [...document.querySelectorAll('[data-testid="add-another"] [data-testid="interaction-option"]')].find((option) => (option.textContent ?? "").includes("Custom"));
      if (!(custom instanceof HTMLElement)) return false;
      custom.click();
      return true;
    })()`, { label: "Custom (OpenAI-compatible)" });
    await waitFor(app, `Boolean(document.querySelector('[data-testid="custom-form"]'))`, { timeoutMs: 30_000, label: "custom server form" });
    expect(await evalIn(app, `[...document.querySelectorAll('[data-testid="custom-form"] input')].map((input) => input.getAttribute("aria-label"))`)).toEqual(["Name", "Address", "Key (optional)"]);
    await fill(app, '[data-testid="custom-form"] input[aria-label="Name"]', "Stub box");
    await fill(app, '[data-testid="custom-form"] input[aria-label="Address"]', `127.0.0.1:${stub.port}`);
    await clickButton(app, "Check");
    const listedModels = await waitFor(app, `(() => {
      const select = document.querySelector('[data-testid="custom-start-model"]');
      return select ? [...select.querySelectorAll("option")].map((option) => option.value) : false;
    })()`, { timeoutMs: 60_000, label: "the stub server's models listed" });
    expect(listedModels).toEqual(STUB_MODELS);
    await evalIn(app, `(() => {
      const select = document.querySelector('[data-testid="custom-start-model"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select, "stub-large");
      select.dispatchEvent(new Event("change", { bubbles: true }));
      return select.value;
    })()`);
    await clickButton(app, "Save");
    evidence.recordAssertionEvidence(
      "A custom OpenAI-compatible server is added with three fields and validated by listing its models first",
      `Connect on the found Ollama server made its two models available; Add another offered the well-known providers plus Custom (OpenAI-compatible), whose form asked only for a name, an address, and an optional key, listed exactly the stub server's two models on Check, and let the person pick stub-large to start with before saving.`,
      true,
    );
  } else {
    await clickButton(app, "Continue");
  }
  // The team steps follow: what the team will help with (six roles, Continue waits for one pick),
  // then a proposed team. This journey takes the blank Add screen instead.
  const intentsStep = await waitFor(app, `(() => {
    const screen = document.querySelector('[data-testid="onboarding-intents"]');
    if (!(screen instanceof HTMLElement)) return false;
    const tiles = [...document.querySelectorAll('[data-testid="onboarding-intent"]')];
    if (tiles.length !== 6) return false;
    const next = document.querySelector('[data-testid="onboarding-intents-continue"]');
    return {
      intents: tiles.map((tile) => tile.getAttribute("data-intent")),
      pressed: tiles.map((tile) => tile.getAttribute("aria-pressed")),
      continueDisabled: next instanceof HTMLButtonElement ? next.disabled : null,
      railVisible: Boolean(document.querySelector('[data-testid="coworker-rail"]')),
    };
  })()`, { timeoutMs: 60_000, label: "the what-will-your-team-help-with step" });
  expect(intentsStep).toEqual({
    intents: ["research", "writing", "operations", "support", "sales", "product"],
    pressed: ["false", "false", "false", "false", "false", "false"],
    continueDisabled: true,
    railVisible: false,
  });
  await evalIn(app, `document.querySelector('[data-testid="onboarding-intents-own"]').click(); true`);
  await waitForText(app, "Add a coworker", { timeoutMs: 60_000 });
  const creationScreen = await evalIn(app, `(() => {
    const screen = document.querySelector('[data-testid="new-coworker"]');
    if (!(screen instanceof HTMLElement)) return null;
    const rect = screen.getBoundingClientRect();
    const text = document.body.innerText.toLowerCase();
    return {
      left: rect.left,
      width: rect.width,
      railVisible: Boolean(document.querySelector('[data-testid="coworker-rail"]')),
      mentionsModel: text.includes("model"),
      mentionsMemoryFiles: text.includes("inspectable files"),
    };
  })()`);
  expect(creationScreen).toMatchObject({ railVisible: false, mentionsModel: false, mentionsMemoryFiles: false });
  if (!isRecord(creationScreen) || typeof creationScreen.left !== "number" || typeof creationScreen.width !== "number") {
    throw new Error("Creation screen layout was unavailable.");
  }
  expect(creationScreen.left).toBeLessThan(3);
  expect(creationScreen.width).toBeGreaterThan(900);
  evidence.recordAssertionEvidence(
    "Adding a coworker takes the whole window and asks only for a name and a look",
    "The creation screen filled the window with no team rail beside it, and neither AI model choice nor memory-file details appeared; those live in Coworker settings once the coworker exists.",
    true,
  );
  await fill(app, 'input[placeholder="Scout"]', "Scout");
  await waitFor(app, `(() => {
    const button = document.querySelector('button[aria-label="Violet"]');
    if (!button) return false;
    button.click();
    return true;
  })()`, { label: "Violet avatar color" });
  await clickButton(app, "Soft square");
  expect(await evalIn(app, `document.querySelector('button[aria-label="Violet"]')?.getAttribute("aria-pressed")`)).toBe("true");
  await clickButton(app, "Add coworker", { timeoutMs: 120_000 });

  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-rail"]'))`, { timeoutMs: 120_000, label: "team rail" });

  if (sameMachine && stub) {
    // The model picked to start with on the local mode screen is the new coworker's model, with no further choice.
    await waitFor(app, `window.__COWORKER__.invoke("coworkers.list").then((response) => response.ok && response.result[0]?.model === "custom-stub-box/stub-large")`, {
      awaitPromise: true,
      timeoutMs: 120_000,
      label: "Scout starts on the custom server's chosen model",
    });
  }
  // The record says who chose the model, so the rule reads the same after a relaunch: a model the person started
  // with on the local mode screen is theirs (never swapped); one the app picked is the app's (swapped once if it fails).
  const firstChoice = await waitFor(app, `window.__COWORKER__.invoke("coworkers.list").then((response) => {
    const scout = (response.result ?? [])[0];
    return scout && scout.model ? { model: scout.model, chosenBy: scout.modelChosenBy } : false;
  })`, { awaitPromise: true, timeoutMs: 120_000, label: "Scout's first model and who chose it" });
  expect(firstChoice).toEqual(sameMachine && stub
    ? { model: "custom-stub-box/stub-large", chosenBy: "person" }
    : { model: expect.stringMatching(/^[a-z0-9-]+\/.+/), chosenBy: "app" });
  const appChoseFirst = isRecord(firstChoice) && firstChoice.chosenBy === "app";

  // A new coworker opens on the conversation alone: one header that carries the
  // coworker, a quiet empty state with no starter cards, and the details panel
  // folded to its icon strip until asked for.
  const conversationFirst = await waitFor(app, `(() => {
    const header = document.querySelector('[data-testid="conversation-header"]');
    const panel = document.querySelector('[data-testid="context-panel"]');
    const empty = document.querySelector('[data-testid="coworker-discussion-empty"]');
    const activityIcon = document.querySelector('[data-testid="context-rail-overview"]');
    if (!(header instanceof HTMLElement) || !(panel instanceof HTMLElement) || !(empty instanceof HTMLElement) || !(activityIcon instanceof HTMLElement)) return false;
    const main = header.closest("div.flex-col");
    const headerCount = main ? main.querySelectorAll("header").length : 0;
    const headerRect = header.getBoundingClientRect();
    const iconRect = activityIcon.getBoundingClientRect();
    return {
      headerHeight: Math.round(headerRect.height),
      headerCount,
      headerName: header.querySelector("h1")?.textContent?.trim(),
      headerLine: document.querySelector('[data-testid="conversation-header-title"]')?.textContent?.trim(),
      panelCollapsed: panel.dataset.collapsed,
      panelWidth: Math.round(panel.getBoundingClientRect().width),
      stripEmptyBand: panel.querySelectorAll("header, .glass-header").length,
      stripStartsInHeaderBand: iconRect.top < headerRect.bottom && iconRect.top > headerRect.top,
      headerIconLabels: [...header.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")).filter(Boolean),
      emptyText: empty.innerText.split("\\n").map((line) => line.trim()).filter(Boolean),
      emptyButtons: empty.querySelectorAll("button").length,
      starterCards: [...document.querySelectorAll("main button")].filter((button) => /focus on today|think through a decision|catch me up/i.test(button.textContent ?? "")).length,
    };
  })()`, { timeoutMs: 60_000, label: "conversation-first workspace" });
  expect(conversationFirst).toMatchObject({
    headerHeight: 78,
    headerCount: 1,
    headerName: "Scout",
    headerLine: "New discussion",
    panelCollapsed: "true",
    panelWidth: 56,
    stripEmptyBand: 0,
    stripStartsInHeaderBand: true,
    headerIconLabels: [],
    emptyButtons: 0,
    starterCards: 0,
  });
  if (!isRecord(conversationFirst) || !Array.isArray(conversationFirst.emptyText)) throw new Error("Conversation-first facts were unavailable.");
  expect(conversationFirst.emptyText[0]).toBe("Scout");
  expect(conversationFirst.emptyText).toContain("What should we work through?");
  evidence.recordAssertionEvidence(
    "A new coworker opens on the conversation with the details panel closed",
    "Scout's workspace opened with a single 78px header naming the coworker and the open discussion, a quiet empty state (small avatar, name, one line) with no starter cards, and the right panel folded to a 56px icon strip whose icons start level with the header, with no empty band above them and no duplicate of them in the header.",
    true,
  );

  // Details open on request: the strip's Activity icon unfolds the Activity view.
  await waitFor(app, `(() => {
    const icon = document.querySelector('[data-testid="context-rail-overview"]');
    if (!(icon instanceof HTMLElement)) return false;
    icon.click();
    return true;
  })()`, { label: "Activity icon" });
  await waitFor(app, `document.querySelector('[data-testid="context-panel"]')?.dataset.collapsed === "false"`, { timeoutMs: 30_000, label: "details panel open" });
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-activity-summary"]'))`, { timeoutMs: 60_000, label: "Activity view" });

  // The Activity view is useful as soon as it opens: what is happening now, then what the
  // coworker holds as three flat rows, and no technical vocabulary. The header owns the one
  // status word; the panel does not repeat it, and there is no second settings control.
  const defaultSidebar = await waitFor(app, `(() => {
    const summary = document.querySelector('[data-testid="coworker-activity-summary"]');
    const status = document.querySelector('[data-testid="coworker-top-status"]');
    if (!(summary instanceof HTMLElement) || !(status instanceof HTMLElement)) return false;
    // The first poll may still be reading the workspace; wait for the settled idle state.
    if (status.textContent?.trim() !== "Ready") return false;
    const summaryLines = summary.innerText.split("\\n").map((line) => line.trim()).filter(Boolean);
    const rows = [...document.querySelectorAll('[data-testid^="activity-row-"]')];
    const sidebarText = (summary.closest("aside")?.innerText ?? "").toLowerCase();
    return {
      summaryLines,
      rows: rows.map((row) => row.innerText.split("\\n").map((line) => line.trim()).filter((line) => line && line !== "›").join(" · ")),
      rowIds: rows.map((row) => row.getAttribute("data-testid")),
      scheduledSectionInActivity: Boolean(document.querySelector('[data-testid="coworker-assignments"], [data-testid="responsibilities-empty"]')),
      settingsButton: Boolean(document.querySelector('[data-testid="coworker-settings-button"]')),
      footerLinks: document.querySelectorAll('nav[aria-label="More for this coworker"] button').length,
      statusDot: status.querySelectorAll("span").length,
      statusTone: status.getAttribute("data-tone"),
      statusTitle: status.getAttribute("title"),
      sidebarMentionsEngine: sidebarText.includes("engine"),
      sidebarMentionsModel: sidebarText.includes("model"),
      readyMentions: (sidebarText.match(/ready/g) ?? []).length,
    };
  })()`, { timeoutMs: 240_000, label: "settled default Activity sidebar" });
  expect(defaultSidebar).toMatchObject({
    summaryLines: ["Waiting for the first assignment."],
    rows: ["Documents", "Workers", "Assignments"],
    rowIds: ["activity-row-documents", "activity-row-workers", "activity-row-assignments"],
    scheduledSectionInActivity: false,
    settingsButton: false,
    footerLinks: 0,
    statusDot: 0,
    statusTone: "mist",
    statusTitle: null,
    sidebarMentionsEngine: false,
    sidebarMentionsModel: false,
    readyMentions: 0,
  });
  // Assignments is a level of Activity: nothing handed over yet, one compact empty state for scheduled work.
  await openActivityLevel(app, "assignments");
  const assignmentsLevel = await waitFor(app, `(() => {
    const view = document.querySelector('[data-testid="coworker-assignments"]');
    const empty = document.querySelector('[data-testid="responsibilities-empty"]');
    const once = document.querySelector('[data-testid="assignments-empty"]');
    if (!(view instanceof HTMLElement) || !(empty instanceof HTMLElement) || !(once instanceof HTMLElement)) return false;
    return {
      onceEmpty: once.textContent?.trim() ?? "",
      newAssignment: Boolean(document.querySelector('[data-testid="new-assignment-button"]')),
      emptyStateCount: document.querySelectorAll('[data-testid="responsibilities-empty"]').length,
      emptyStateText: empty.textContent?.trim() ?? "",
      cards: view.querySelectorAll(".rounded-2xl").length,
      panelTitle: document.querySelector('[data-testid="context-panel"] [data-testid="panel-crumb"][aria-current="page"]')?.textContent?.trim() ?? "",
      back: document.querySelector('[data-testid="panel-back"]')?.getAttribute("aria-label") ?? "",
    };
  })()`, { timeoutMs: 30_000, label: "Activity › Assignments" });
  expect(assignmentsLevel).toMatchObject({ newAssignment: true, emptyStateCount: 1, cards: 0, panelTitle: "Assignments", back: "Back to Activity" });
  if (!isRecord(assignmentsLevel) || typeof assignmentsLevel.emptyStateText !== "string" || typeof assignmentsLevel.onceEmpty !== "string") throw new Error("Assignments level facts were unavailable.");
  expect(assignmentsLevel.onceEmpty).toContain("Nothing handed over yet.");
  expect(assignmentsLevel.emptyStateText).toContain("Nothing on a schedule yet.");
  expect(assignmentsLevel.emptyStateText).toContain("Add assignment");
  // Workers is its own level, holding Workers only.
  await openActivityLevel(app, "workers");
  const workersLevel = await waitFor(app, `(() => {
    const view = document.querySelector('[data-testid="coworker-workers"]');
    const workersEmpty = document.querySelector('[data-testid="workers-empty"]');
    // The Workers list arrives a moment after the view; read it once its empty state has settled.
    if (!(view instanceof HTMLElement) || !(workersEmpty instanceof HTMLElement)) return false;
    return {
      workersEmpty: workersEmpty.textContent?.trim() ?? "",
      newWorker: Boolean(document.querySelector('[data-testid="new-worker-button"]')),
      assignmentsHere: Boolean(document.querySelector('[data-testid="coworker-assignments"]')),
      panelTitle: document.querySelector('[data-testid="context-panel"] [data-testid="panel-crumb"][aria-current="page"]')?.textContent?.trim() ?? "",
    };
  })()`, { timeoutMs: 30_000, label: "Activity › Workers" });
  expect(workersLevel).toMatchObject({ newWorker: true, assignmentsHere: false, panelTitle: "Workers" });
  if (!isRecord(workersLevel) || typeof workersLevel.workersEmpty !== "string") throw new Error("Workers level facts were unavailable.");
  expect(workersLevel.workersEmpty).toContain("No Workers running. Ask Scout to start one, or start one here.");
  await evalIn(app, `document.querySelector('[data-testid="panel-back"]').click()`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-activity-summary"]'))`, { timeoutMs: 30_000, label: "back on Activity" });
  const composerFacts = await evalIn(app, `(() => {
    const composer = document.querySelector('textarea[aria-label="Message Scout"]')?.closest('[data-testid="coworker-composer"]');
    const text = (composer?.textContent ?? "").toLowerCase();
    return {
      present: Boolean(composer),
      hasModelControl: Boolean(document.querySelector('[data-testid="composer-model-control"]')),
      mentionsModel: text.includes("model") || text.includes("thinking effort"),
      brandLine: text.includes("powered by"),
      summaryLine: Boolean(composer?.querySelector('[data-testid="coworker-summary-line"]')),
    };
  })()`);
  // A coworker that has never held or finished anything gets no summary line under its first message.
  expect(composerFacts).toEqual({ present: true, hasModelControl: false, mentionsModel: false, brandLine: false, summaryLine: false });
  // Returning to Activity re-opens the panel with its 180ms unfold; let it settle before measuring it.
  await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    return panel instanceof HTMLElement && panel.dataset.collapsed === "false" && panel.getBoundingClientRect().width >= 320;
  })()`, { timeoutMs: 10_000, label: "context panel open and settled" });
  evidence.recordAssertionEvidence(
    "The Activity view leads with what is happening, holds Documents, Workers, and Assignments as levels, and the composer carries no model controls or brand line",
    "Once opened, Scout's Activity view showed one quiet note, three flat rows (Documents, Workers, Assignments) with no card, no second settings control, and no footer links, while the header carried the only Ready — plain text, no dot; the Assignments row opened its level with New assignment, an empty once list, and a single compact Add assignment empty state (Nothing on a schedule yet.); the Workers row opened a level with Workers only and New Worker; the panel and composer contained no model, thinking-effort, or engine vocabulary, and the composer carried neither a brand line nor a summary line for a coworker that has nothing yet.",
    true,
  );

  // Both side panels fold away with a click on their edge (there is no fold button). The
  // team rail keeps every coworker as an avatar with a status dot and a hover card, and
  // marks the active one; the context panel keeps its four destinations as icons that
  // unfold straight into the chosen view.
  const foldedPanels = await evalIn(app, `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const q = (selector) => document.querySelector(selector);
    const rail = q('[data-testid="coworker-rail"]');
    const panel = q('[data-testid="context-panel"]');
    if (!(rail instanceof HTMLElement) || !(panel instanceof HTMLElement)) return null;
    const expandedRailWidth = rail.getBoundingClientRect().width;
    const expandedRailLogo = Boolean(rail.querySelector('svg.coworker-mark'));
    const expandedPanelWidth = panel.getBoundingClientRect().width;
    const foldButtons = document.querySelectorAll('[data-testid$="-collapse"], [data-testid$="-expand"], [aria-label="Hide panel"], [aria-label="Show panel"], [aria-label="Hide team details"], [aria-label="Show team details"]').length;
    q('[data-testid="coworker-rail-resizer"]')?.click();
    q('[data-testid="context-panel-resizer"]')?.click();
    await wait(400);
    const avatar = q('[data-testid="coworker-rail-avatar"]');
    const indicator = q('[data-testid="coworker-rail-indicator"]');
    avatar?.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
    await wait(150);
    const peek = q('[data-testid="coworker-rail-peek"]');
    const peekRect = peek?.getBoundingClientRect();
    const railRect = rail.getBoundingClientRect();
    const collapsed = {
      foldButtons,
      railWidth: railRect.width,
      panelWidth: panel.getBoundingClientRect().width,
      railSearchVisible: q('input[aria-label="Search coworkers"]') instanceof HTMLElement,
      railLogoVisible: Boolean(rail.querySelector('svg.coworker-mark')),
      railSearchIcon: q('[data-testid="coworker-rail-search"]')?.getAttribute("aria-label"),
      avatarCount: document.querySelectorAll('[data-testid="coworker-rail-avatar"]').length,
      avatarLabel: avatar?.getAttribute("aria-label"),
      avatarCurrent: avatar?.getAttribute("aria-current"),
      indicatorTone: indicator?.dataset.tone,
      indicatorAtBottom: indicator && avatar ? indicator.getBoundingClientRect().bottom > avatar.getBoundingClientRect().top + avatar.getBoundingClientRect().height / 2 : false,
      peekText: peek?.innerText ?? "",
      peekRightOfRail: peekRect ? peekRect.left >= railRect.right : false,
      panelIcons: [...document.querySelectorAll('[data-testid^="context-rail-"]')].map((button) => button.getAttribute("aria-label") + ":" + button.dataset.active),
      panelIconText: [...document.querySelectorAll('[data-testid^="context-rail-"]')].map((button) => button.textContent?.trim()).join(""),
    };
    avatar?.dispatchEvent(new PointerEvent("pointerout", { bubbles: true }));
    q('[data-testid="context-rail-memory"]')?.click();
    await wait(400);
    const afterIcon = { view: panel.dataset.view, collapsed: panel.dataset.collapsed, panelWidth: panel.getBoundingClientRect().width };
    // Dragging the rail edge closed folds it; dragging it back out reopens it at the pointer.
    const dragRail = async (toX) => {
      const resizer = q('[data-testid="coworker-rail-resizer"]');
      const rect = resizer.getBoundingClientRect();
      resizer.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: rect.left + 5, clientY: 300, pointerId: 1 }));
      await wait(30);
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: toX, clientY: 300, pointerId: 1 }));
      await wait(30);
      window.dispatchEvent(new PointerEvent("pointerup", { clientX: toX, clientY: 300, pointerId: 1 }));
      await wait(400);
      return rail.getBoundingClientRect().width;
    };
    const draggedOpen = await dragRail(300);
    const draggedClosed = await dragRail(40);
    // A click on the folded edge reopens the rail; the search icon does too, with the cursor in the box.
    q('[data-testid="coworker-rail-resizer"]')?.click();
    await wait(400);
    const reopenedFromEdge = rail.getBoundingClientRect().width;
    q('[data-testid="coworker-rail-resizer"]')?.click();
    await wait(400);
    const refoldedWidth = rail.getBoundingClientRect().width;
    q('[data-testid="coworker-rail-search"]')?.click();
    await wait(400);
    const reopened = rail.getBoundingClientRect().width;
    const searchFocused = document.activeElement === q('input[aria-label="Search coworkers"]');
    // Back to the Activity overview so the rest of the journey sees the default panel.
    q('[aria-label="Back to activity"]')?.click();
    await wait(200);
    return {
      expandedRailWidth,
      expandedRailLogo,
      expandedPanelWidth,
      collapsed,
      afterIcon,
      draggedOpen,
      draggedClosed,
      reopenedFromEdge,
      refoldedWidth,
      reopened,
      searchFocused,
      finalView: panel.dataset.view,
      settingsButtonBack: Boolean(q('[data-testid="coworker-settings-button"]')),
      stripTooltip: await (async () => {
        // Hovering a strip icon names the view and what it shows, in the coworker's name.
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await wait(300);
        const icon = q('[data-testid="context-rail-overview"]');
        icon?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        await wait(700);
        const tip = q('[role="tooltip"][data-testid="tooltip"]');
        const facts = {
          text: tip?.textContent ?? "",
          side: tip?.getAttribute("data-side") ?? "",
          describedBy: Boolean(tip) && icon?.getAttribute("aria-describedby") === tip?.id,
          leftOfStrip: tip && icon ? tip.getBoundingClientRect().right <= icon.getBoundingClientRect().left : false,
          nativeTitle: icon?.getAttribute("title"),
        };
        icon?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
        await wait(100);
        const gone = !q('[role="tooltip"][data-testid="tooltip"]');
        icon?.click();
        await wait(400);
        return { ...facts, gone };
      })(),
    };
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  if (!isRecord(foldedPanels) || !isRecord(foldedPanels.collapsed) || !isRecord(foldedPanels.afterIcon)) throw new Error("Folded panel facts were unavailable.");
  expect(foldedPanels.expandedRailWidth).toBeGreaterThanOrEqual(220);
  expect(foldedPanels.expandedRailLogo).toBe(false);
  expect(foldedPanels.expandedPanelWidth).toBeGreaterThanOrEqual(320);
  expect(foldedPanels.collapsed).toMatchObject({
    foldButtons: 0,
    railWidth: 88,
    panelWidth: 56,
    railLogoVisible: false,
    railSearchIcon: "Search coworkers",
    railSearchVisible: false,
    avatarCount: 1,
    avatarLabel: "Scout",
    avatarCurrent: "true",
    indicatorTone: "mist",
    indicatorAtBottom: true,
    peekRightOfRail: true,
    panelIcons: ["Activity:true", "Memory:false", "Coworker settings:false"],
    panelIconText: "",
  });
  expect(String(foldedPanels.collapsed.peekText)).toContain("Scout");
  expect(String(foldedPanels.collapsed.peekText)).toContain("Ready");
  expect(foldedPanels.afterIcon).toMatchObject({ view: "memory", collapsed: "false" });
  expect(foldedPanels.afterIcon.panelWidth).toBeGreaterThanOrEqual(320);
  expect(foldedPanels.draggedOpen).toBeGreaterThanOrEqual(220);
  expect(foldedPanels.draggedClosed).toBe(88);
  expect(foldedPanels.reopenedFromEdge).toBeGreaterThanOrEqual(220);
  expect(foldedPanels.refoldedWidth).toBe(88);
  expect(foldedPanels.reopened).toBeGreaterThanOrEqual(220);
  expect(foldedPanels.searchFocused).toBe(true);
  expect(foldedPanels.finalView).toBe("overview");
  expect(foldedPanels.settingsButtonBack).toBe(false);
  expect(foldedPanels.stripTooltip).toEqual({
    text: "Activity — what Scout is doing now, recently, and the assignments, Workers, and documents it holds",
    side: "left",
    describedBy: true,
    leftOfStrip: true,
    nativeTitle: null,
    gone: true,
  });
  evidence.recordAssertionEvidence(
    "Both side panels fold to icon rails and unfold from them",
    "With no fold buttons anywhere, a click on each panel's edge folded it: the team rail became an 88px rail clear of the window controls, without the logo, with a search icon, Scout's avatar marked current, a bottom status dot, and a hover card beside the rail naming Scout and Ready; the context panel became a 56px strip with exactly three icons — Activity, Memory, and Coworker settings — and no words, and choosing Memory unfolded the panel on that view. Resting on the Activity icon showed one tooltip beside the strip (Activity — what Scout is doing now, recently, and the assignments, Workers, and documents it holds), named to assistive tech and with no native title behind it. Dragging the rail edge past the fold threshold closed it, a click on the edge reopened and refolded it, and the search icon reopened it with the cursor in the search box.",
    true,
  );

  // The open panel is transient: Escape closes it, a strip icon reopens it on that view,
  // and a click on its edge closes it again.
  const transientPanel = await evalIn(app, `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const q = (selector) => document.querySelector(selector);
    const panel = q('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return null;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await wait(400);
    const afterEscape = { collapsed: panel.dataset.collapsed, width: Math.round(panel.getBoundingClientRect().width), stripIcons: document.querySelectorAll('[data-testid^="context-rail-"]').length };
    q('[data-testid="context-rail-overview"]')?.click();
    await wait(400);
    const afterOpen = { collapsed: panel.dataset.collapsed, view: panel.dataset.view, stripIcons: document.querySelectorAll('[data-testid^="context-rail-"]').length };
    q('[data-testid="context-panel-resizer"]')?.click();
    await wait(400);
    const afterEdge = { collapsed: panel.dataset.collapsed, width: Math.round(panel.getBoundingClientRect().width) };
    q('[data-testid="context-rail-overview"]')?.click();
    await wait(400);
    return { afterEscape, afterOpen, afterEdge, finalCollapsed: panel.dataset.collapsed };
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(transientPanel).toEqual({
    afterEscape: { collapsed: "true", width: 56, stripIcons: 3 },
    afterOpen: { collapsed: "false", view: "overview", stripIcons: 0 },
    afterEdge: { collapsed: "true", width: 56 },
    finalCollapsed: "false",
  });
  evidence.recordAssertionEvidence(
    "The details panel is transient",
    "Escape folded the open panel back to its 56px strip of three icons, the strip's Activity icon reopened it on Activity (the strip icons giving way to the panel), and a click on the panel's edge folded it again.",
    true,
  );

  // Model choice lives in Coworker settings, reached from the strip's icon (the panel folds first).
  await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    if (panel.dataset.collapsed === "false" && panel.dataset.view === "settings") return true;
    if (panel.dataset.collapsed === "true") document.querySelector('[data-testid="context-rail-settings"]')?.click();
    else window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  })()`, { timeoutMs: 30_000, label: "Coworker settings from the strip" });
  await waitForText(app, "Coworker settings", { timeoutMs: 30_000 });
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-model-settings"]'))`, { timeoutMs: 30_000, label: "AI model section" });
  // Apps & tools is the first row of these settings, above who the coworker is.
  expect(await evalIn(app, `(() => {
    const row = document.querySelector('[data-testid="settings-row-apps-tools"]');
    const profile = document.querySelector('[data-testid="coworker-profile-settings"]');
    return Boolean(row && profile) && row.getBoundingClientRect().top < profile.getBoundingClientRect().top && (row.textContent ?? "").includes("Apps & tools");
  })()`)).toBe(true);
  expect(String(await evalIn(app, `document.querySelector('[data-testid="coworker-model-settings"]')?.innerText ?? ""`))).toContain("AI model");
  // A model the app chose says so in one plain line, with where it came from; a model the person chose has no such line.
  const chosenForYou = await waitFor(app, `(() => {
    const section = document.querySelector('[data-testid="coworker-model-settings"]');
    const picker = section?.querySelector('[data-testid="model-picker"] > button');
    if (!(picker instanceof HTMLElement) || !(picker.textContent ?? "").trim()) return false;
    const line = section?.querySelector('[data-testid="model-chosen-for-you"]');
    return { shown: Boolean(line), text: line?.textContent?.trim() ?? "" };
  })()`, { timeoutMs: 60_000, label: "the AI model row with or without its chosen-for-you line" });
  expect(chosenForYou).toEqual(appChoseFirst
    ? { shown: true, text: expect.stringMatching(/^Chosen for you, (from your OpenWork account|from a subscription or key on this Mac|from a model server on this Mac|the free model, nothing to set up)\. It stays until you pick one; if it can't answer, the next best takes over once\.$/) }
    : { shown: false, text: "" });
  // Who the coworker is comes before what it runs on.
  expect(await evalIn(app, `(() => {
    const profile = document.querySelector('[data-testid="coworker-profile-settings"]');
    const model = document.querySelector('[data-testid="coworker-model-settings"]');
    return Boolean(profile && model) && profile.getBoundingClientRect().top < model.getBoundingClientRect().top;
  })()`)).toBe(true);
  await waitFor(app, `(() => {
    const button = document.querySelector('[data-testid="model-picker"] > button');
    if (!(button instanceof HTMLElement)) return false;
    button.click();
    return true;
  })()`, { label: "open the AI model picker" });
  await waitFor(app, `Boolean(document.querySelector('input[aria-label="Search AI models"]'))`, {
    timeoutMs: 120_000,
    label: "AI model search",
  });
  // Everything connected on this Mac is labelled This Mac in the picker, the Codex-connected OpenAI included.
  await waitFor(app, `document.querySelector('[data-testid="model-provider-openai"] [data-testid="model-source-local"]')?.textContent?.trim() === "This Mac"`, { timeoutMs: 60_000, label: "OpenAI models labelled This Mac" });
  expect(await evalIn(app, `document.querySelector('[data-testid="model-provider-google"] [data-testid="model-source-local"]')?.textContent?.trim()`)).toBe("This Mac");
  await fill(app, 'input[aria-label="Search AI models"]', "big-pickle");
  await clickButtonContaining(app, "big-pickle");
  await waitFor(app, `(document.querySelector('[data-testid="model-picker"]')?.textContent ?? "").includes("Big Pickle")`, {
    timeoutMs: 30_000,
    label: "Big Pickle selected in Coworker settings",
  });
  // The person chose: the record says so, the chosen-for-you line is gone, and this model is never swapped.
  await waitFor(app, `window.__COWORKER__.invoke("coworkers.get", { slug: "scout" }).then((response) => response.result?.model === "opencode/big-pickle" && response.result?.modelChosenBy === "person")`, {
    awaitPromise: true,
    timeoutMs: 30_000,
    label: "Scout's record says the person chose Big Pickle",
  });
  expect(await evalIn(app, `Boolean(document.querySelector('[data-testid="model-chosen-for-you"]'))`)).toBe(false);
  const thinkingEffort = await evalIn(app, `(() => {
    const section = document.querySelector('[data-testid="coworker-model-settings"]');
    const labels = [...(section?.querySelectorAll("label") ?? [])].map((label) => label.textContent ?? "");
    return {
      hasSelect: Boolean(section?.querySelector("select")),
      mentionsThinkingEffort: labels.some((label) => label.includes("Thinking effort")),
      sectionText: section?.innerText ?? "",
    };
  })()`);
  if (!isRecord(thinkingEffort)) throw new Error("Thinking effort facts were unavailable.");
  // A model that exposes reasoning variants gets the Thinking effort control here and nowhere else;
  // one that does not gets nothing, rather than a disabled control.
  expect(thinkingEffort.hasSelect).toBe(thinkingEffort.mentionsThinkingEffort);
  expect(String(thinkingEffort.sectionText)).toContain("thinking effort");
  await waitFor(app, `(() => {
    const back = document.querySelector('button[aria-label="Back to activity"]');
    if (!(back instanceof HTMLElement)) return false;
    back.click();
    return true;
  })()`, { label: "back to the Activity sidebar" });
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-activity-summary"]'))`, { timeoutMs: 30_000, label: "Activity sidebar restored" });
  evidence.recordAssertionEvidence(
    "A coworker's AI model and thinking effort are configured in Coworker settings",
    `The strip's Coworker settings icon opened the settings with Apps & tools as their first row, then the AI model section${appChoseFirst ? ", whose one line said the model was chosen for the person and where it came from" : ", with no chosen-for-you line because the person had started this model on the local mode screen"}; the searchable picker selected Big Pickle for Scout, the record then said the person chose it and the line was gone, and the thinking-effort control appears only when the chosen model offers reasoning variants.`,
    true,
  );
  const avatarMotion = await evalIn(app, `(() => {
    const avatar = document.querySelector('svg[aria-label="Scout avatar"].is-animated');
    if (!avatar) return null;
    const bounds = avatar.getBoundingClientRect();
    window.dispatchEvent(new PointerEvent("pointermove", {
      clientX: bounds.right + 24,
      clientY: bounds.top - 24,
    }));
    const read = (selector) => {
      const element = avatar.querySelector(selector);
      if (!element) return null;
      const style = getComputedStyle(element);
      return {
        animationName: style.animationName,
        animationDuration: style.animationDuration,
        animationDelay: style.animationDelay,
      };
    };
    return {
      body: read(".coworker-avatar__body"),
      depth: read(".coworker-avatar__depth"),
      features: read(".coworker-avatar__features"),
      gaze: read(".coworker-avatar__gaze"),
      pupils: read(".coworker-avatar__pupils"),
      glasses: Boolean(avatar.querySelector(".coworker-avatar__glasses")),
      pointerBody: Boolean(avatar.querySelector(".coworker-avatar__pointer-body")),
    };
  })()`);
  expect(avatarMotion).toMatchObject({
    body: { animationName: "coworker-float", animationDuration: "8.8s" },
    depth: { animationName: "coworker-depth-turn", animationDuration: "8.8s" },
    features: { animationName: "coworker-feature-turn", animationDuration: "8.8s" },
    gaze: { animationName: "coworker-gaze-turn", animationDuration: "8.8s" },
    pupils: { animationName: "coworker-blink", animationDuration: "8.2s", animationDelay: "-1.4s" },
    glasses: true,
    pointerBody: true,
  });
  if (!isRecord(avatarMotion)) throw new Error("Scout avatar motion layers were unavailable.");
  const animatedLayers = ["body", "depth", "features", "gaze"]
    .map((key) => avatarMotion[key])
    .filter(isRecord);
  expect(new Set(animatedLayers.map((layer) => layer.animationDelay)).size).toBe(1);
  // The gaze settles on the next animation frames; poll for it rather than holding one long
  // evaluation open, so a momentary renderer stall on a slow display does not read as a failure.
  // Each poll moves the pointer again and reads the gaze rendered since the previous tick, so a
  // focus change (which resets the gaze) or a slow frame cannot leave a stale zero behind.
  const coworkerGaze = await waitFor(app, `(() => {
    const avatar = document.querySelector('svg[aria-label="Scout avatar"].is-animated');
    if (!avatar) return false;
    const bounds = avatar.getBoundingClientRect();
    window.dispatchEvent(new PointerEvent("pointermove", {
      clientX: bounds.left - Math.max(24, bounds.width),
      clientY: bounds.bottom + Math.max(24, bounds.height),
    }));
    const lookX = Number.parseFloat(avatar.style.getPropertyValue("--avatar-look-x"));
    const lookY = Number.parseFloat(avatar.style.getPropertyValue("--avatar-look-y"));
    if (!Number.isFinite(lookX) || !Number.isFinite(lookY) || lookX >= 0 || lookY <= 0) return false;
    return {
      hasPointerLayer: avatar.querySelector(".coworker-avatar__pointer-gaze") !== null,
      lookX,
      lookY,
      featureLookX: Number.parseFloat(avatar.style.getPropertyValue("--avatar-feature-look-x")),
      featureLookY: Number.parseFloat(avatar.style.getPropertyValue("--avatar-feature-look-y")),
      headX: Number.parseFloat(avatar.style.getPropertyValue("--avatar-head-x")),
      headY: Number.parseFloat(avatar.style.getPropertyValue("--avatar-head-y")),
      turn: Number.parseFloat(avatar.style.getPropertyValue("--avatar-turn")),
    };
  })()`, { timeoutMs: 30_000, label: "Scout's gaze following a lower-left pointer" });
  expect(coworkerGaze).toMatchObject({
    hasPointerLayer: true,
    lookX: expect.any(Number),
    lookY: expect.any(Number),
  });
  if (!isRecord(coworkerGaze) || typeof coworkerGaze.lookX !== "number" || typeof coworkerGaze.lookY !== "number") {
    throw new Error("Scout's pointer gaze was unavailable.");
  }
  expect(coworkerGaze.lookX).toBeLessThan(0);
  expect(Math.abs(coworkerGaze.lookX)).toBeLessThanOrEqual(1.5);
  expect(coworkerGaze.lookY).toBeGreaterThan(0);
  expect(coworkerGaze.lookY).toBeLessThanOrEqual(1.1);
  expect(Number(coworkerGaze.featureLookX)).toBeLessThan(0);
  expect(Number(coworkerGaze.featureLookY)).toBeGreaterThan(0);
  expect(Number(coworkerGaze.headX)).toBeLessThan(0);
  expect(Number(coworkerGaze.headY)).toBeGreaterThan(0);
  expect(Number(coworkerGaze.turn)).toBeLessThan(0);
  expect(Math.abs(Number(coworkerGaze.turn))).toBeLessThanOrEqual(1.7);
  evidence.recordAssertionEvidence(
    "The coworker avatar coordinates its head turn and keeps a restrained eye on the pointer",
    "Scout's glasses and pupils followed a lower-left pointer at coordinated strengths while the whole avatar added a sub-two-degree lean and a fraction-of-a-pixel vertical nod. Its independent blink cadence remained intact.",
    true,
  );
  const storedCoworker = await invokeCoworker(app, "coworkers.get", { slug: "scout" });
  expect(storedCoworker).toMatchObject({
    ok: true,
    result: {
      name: "Scout",
      avatarColor: "violet",
      avatarGlasses: "square",
      model: "opencode/big-pickle",
      workspaceId: expect.any(String),
    },
  });
  evidence.recordAssertionEvidence(
    "A coworker's identity, appearance, native workspace, and selected OpenWork model persist together",
    "The renderer-created Scout record round-tripped through the main-process bridge with violet color, soft-square glasses, a native workspace id, and opencode/big-pickle.",
    true,
  );

  const secondCoworker = await invokeCoworker(app, "coworkers.create", {
    name: "Nova",
    role: "Research partner",
    mission: "Keep research work moving.",
    avatarColor: "mint",
    avatarGlasses: "round",
  });
  expect(secondCoworker).toMatchObject({ ok: true, result: { slug: "nova" } });
  await evalIn(app, "location.reload(); true");
  await waitForText(app, "Nova", { timeoutMs: 120_000 });
  const railAvatars = await waitFor(app, `(() => {
    const avatars = [...document.querySelectorAll("aside nav svg.coworker-avatar")];
    if (avatars.length !== 2) return false;
    window.dispatchEvent(new PointerEvent("pointermove", {
      clientX: window.innerWidth - 2,
      clientY: window.innerHeight - 2,
    }));
    const facts = avatars.map((avatar) => {
      const pupils = avatar.querySelector(".coworker-avatar__pupils");
      const blink = pupils ? getComputedStyle(pupils) : null;
      return {
        name: avatar.getAttribute("aria-label"),
        animated: avatar.classList.contains("is-animated"),
        blinkName: blink?.animationName ?? "",
        blinkDuration: blink?.animationDuration ?? "",
        blinkDelay: blink?.animationDelay ?? "",
        lookX: Number.parseFloat(avatar.style.getPropertyValue("--avatar-look-x")),
        lookY: Number.parseFloat(avatar.style.getPropertyValue("--avatar-look-y")),
        featureLookY: Number.parseFloat(avatar.style.getPropertyValue("--avatar-feature-look-y")),
        headY: Number.parseFloat(avatar.style.getPropertyValue("--avatar-head-y")),
        turn: Number.parseFloat(avatar.style.getPropertyValue("--avatar-turn")),
      };
    });
    // Both avatars have turned toward the bottom-right pointer once every look value is positive.
    return facts.every((fact) => fact.lookX > 0 && fact.lookY > 0 && fact.featureLookY > 0) ? facts : false;
  })()`, { timeoutMs: 30_000, label: "both rail avatars following the pointer" });
  expect(railAvatars).toHaveLength(2);
  expect(railAvatars).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "Scout avatar", animated: true, blinkName: "coworker-blink", blinkDuration: "8.2s", blinkDelay: "-1.4s" }),
    expect.objectContaining({ name: "Nova avatar", animated: true, blinkName: "coworker-blink", blinkDuration: "10.5s", blinkDelay: "-8.2s" }),
  ]));
  if (!Array.isArray(railAvatars) || !railAvatars.every(isRecord)) {
    throw new Error("Left-rail coworker motion was unavailable.");
  }
  expect(railAvatars.every((avatar) => typeof avatar.lookX === "number" && avatar.lookX > 0)).toBe(true);
  expect(railAvatars.every((avatar) => typeof avatar.lookY === "number" && avatar.lookY > 0)).toBe(true);
  expect(railAvatars.every((avatar) => typeof avatar.featureLookY === "number" && avatar.featureLookY > 0)).toBe(true);
  expect(railAvatars.every((avatar) => typeof avatar.headY === "number" && avatar.headY > 0)).toBe(true);
  expect(railAvatars.every((avatar) => typeof avatar.turn === "number" && avatar.turn > 0 && avatar.turn <= 1.7)).toBe(true);
  expect(new Set(railAvatars.map((avatar) => avatar.blinkDuration)).size).toBe(2);
  evidence.recordAssertionEvidence(
    "Every coworker in the left rail follows the pointer with its eyes and glasses",
    "Scout and Nova moved their eyewear and pupils toward the same bottom-right pointer, then added a restrained whole-avatar nod and lean. Both stayed animated while unselected and retained different blink durations and offsets so the team never blinked in sync.",
    true,
  );
  // Idle glances are skipped while the window is hidden or covered (they are for a person who
  // can see them), so make sure the window is in front before waiting for one.
  await app.client.send("Page.bringToFront", {});
  // The glance-and-blink overlap lasts about a quarter of a second every five to twelve
  // seconds; polling over the wire would miss it, so the page itself records the moment
  // both classes are present, with the values in force at that instant.
  await evalIn(app, `(() => {
    const avatars = [...document.querySelectorAll("aside nav svg.coworker-avatar")];
    if (avatars.length === 0) return false;
    window.__idleGlance = null;
    const capture = (avatar) => {
      if (window.__idleGlance || !(avatar instanceof SVGSVGElement)) return;
      if (!avatar.classList.contains("is-idle-looking") || !avatar.classList.contains("is-idle-blinking")) return;
      const pupils = avatar.querySelector(".coworker-avatar__pupils");
      const pointerBody = avatar.querySelector(".coworker-avatar__pointer-body");
      window.__idleGlance = {
        name: avatar.getAttribute("aria-label"),
        featureY: Number.parseFloat(avatar.style.getPropertyValue("--avatar-idle-feature-y")),
        lookY: Number.parseFloat(avatar.style.getPropertyValue("--avatar-idle-look-y")),
        headY: Number.parseFloat(avatar.style.getPropertyValue("--avatar-idle-head-y")),
        turn: Number.parseFloat(avatar.style.getPropertyValue("--avatar-idle-turn")),
        blinkAnimation: pupils ? getComputedStyle(pupils).animationName : "",
        bobAnimation: pointerBody ? getComputedStyle(pointerBody).animationName : "",
      };
    };
    const observer = new MutationObserver((records) => {
      for (const record of records) capture(record.target);
    });
    for (const avatar of avatars) observer.observe(avatar, { attributes: true, attributeFilter: ["class"] });
    window.__idleGlanceObserver = observer;
    return true;
  })()`);
  const idleAvatar = await waitFor(app, `window.__idleGlance ?? false`, { timeoutMs: 30_000, label: "a coworker's unscripted idle glance and blink" });
  await evalIn(app, `(() => { window.__idleGlanceObserver?.disconnect(); return true; })()`);
  expect(idleAvatar).toMatchObject({
    name: expect.stringMatching(/^(Scout|Nova) avatar$/),
    featureY: 0.65,
    lookY: 1.2,
    headY: 0.25,
    turn: expect.any(Number),
    blinkAnimation: "coworker-idle-blink",
    bobAnimation: "coworker-idle-bob",
  });
  if (!isRecord(idleAvatar) || typeof idleAvatar.turn !== "number") {
    throw new Error("The coworker's idle glance was unavailable.");
  }
  expect(Math.abs(idleAvatar.turn)).toBe(0.35);
  evidence.recordAssertionEvidence(
    "Coworkers make small unscripted glances while they wait",
    "After the pointer became still, one rail avatar briefly looked down: its glasses, pupils, and whole-avatar pose moved by separate sub-pixel amounts with a 0.35-degree lean, and its short blink carried a sub-pixel check-and-rebound before it settled back.",
    true,
  );
  await clickButtonContaining(app, "Scout");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Scout")`, { timeoutMs: 30_000, label: "Scout discussion view" });

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
  await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="context-panel"]');
    if (!(panel instanceof HTMLElement)) return false;
    if (panel.dataset.collapsed === "false" && panel.dataset.view === "memory") return true;
    if (panel.dataset.collapsed === "true") document.querySelector('[data-testid="context-rail-memory"]')?.click();
    else window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    return false;
  })()`, { timeoutMs: 60_000, label: "Memory view" });
  const memoryTabs = await waitFor(app, `(() => {
    const panel = document.querySelector('[data-testid="memory-panel"]');
    const count = panel?.querySelector('[data-testid="memory-count"]');
    if (!panel || !count) return false;
    const view = panel.querySelector('[data-testid="memory-view"]');
    if (!view) return false;
    return {
      tabs: [...panel.querySelectorAll('nav[aria-label="Memory"] button')].map((button) => button.getAttribute("data-testid")),
      count: count.textContent?.trim(),
      renderedHeading: view.querySelector("h1")?.textContent?.trim() ?? "",
      rawTextareaVisible: panel.querySelector("textarea") !== null,
      mentionsIndexAsTab: (panel.querySelector("nav")?.textContent ?? "").includes("index"),
    };
  })()`, { timeoutMs: 30_000, label: "memory panel with structured tabs" });
  expect(memoryTabs).toEqual({
    tabs: ["memory-tab-soul", "memory-tab-working", "memory-tab-long-term"],
    count: "3",
    renderedHeading: "Working memory — Scout",
    rawTextareaVisible: false,
    mentionsIndexAsTab: false,
  });
  await evalIn(app, `document.querySelector('[data-testid="memory-tab-long-term"]').click()`);
  const memoryRows = await waitFor(app, `(() => {
    const rows = [...document.querySelectorAll('[data-testid="memory-row"]')];
    if (rows.length !== 3) return false;
    return rows.map((row) => ({
      file: row.getAttribute("data-file"),
      title: row.querySelector("span")?.textContent?.trim() ?? "",
      badge: [...row.querySelectorAll("span")].map((span) => span.textContent?.trim() ?? "").find((text) => text === "File missing" || text === "Not in index") ?? "",
      summary: row.querySelector("p")?.textContent?.trim() ?? "",
    }));
  })()`, { timeoutMs: 30_000, label: "three long-term memory rows" });
  expect(memoryRows).toEqual([
    { file: "cleaning-day.md", title: "Street cleaning", badge: "", summary: "Street cleaning: move car every Friday" },
    { file: "gone.md", title: "Gone", badge: "File missing", summary: "Promoted, then lost" },
    { file: "stray.md", title: "Stray", badge: "Not in index", summary: "" },
  ]);

  // Selecting a memory renders it; Edit exposes the file, and a saved edit lands on disk.
  await evalIn(app, `document.querySelector('[data-testid="memory-row"][data-file="cleaning-day.md"]').click()`);
  const memoryDetail = await waitFor(app, `(() => {
    const detail = document.querySelector('[data-testid="memory-detail"][data-file="cleaning-day.md"]');
    const view = detail?.querySelector('[data-testid="memory-view"]');
    if (!detail || !view) return false;
    return {
      heading: view.querySelector("h1")?.textContent?.trim() ?? "",
      emphasis: view.querySelector("strong")?.textContent?.trim() ?? "",
      listItems: view.querySelectorAll("li").length,
      path: detail.textContent?.includes("memory/long-term/cleaning-day.md") ?? false,
      rawTextareaVisible: detail.querySelector("textarea") !== null,
    };
  })()`, { timeoutMs: 30_000, label: "rendered memory detail" });
  expect(memoryDetail).toEqual({ heading: "Street cleaning", emphasis: "Friday", listItems: 1, path: true, rawTextareaVisible: false });
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
  await waitFor(app, `document.querySelectorAll('[data-testid="memory-view"] li').length === 2`, { timeoutMs: 30_000, label: "rendered edit" });

  // Forgetting a memory removes the file and its index line together, after an explicit confirmation.
  await clickButton(app, "Delete…");
  await waitFor(app, `document.querySelector('[data-testid="memory-delete-confirm"]') !== null`, { timeoutMs: 30_000, label: "delete confirmation" });
  await clickButton(app, "Delete memory");
  const afterDelete = await waitFor(app, `(() => {
    if (document.querySelector('[data-testid="memory-detail"]')) return false;
    const rows = [...document.querySelectorAll('[data-testid="memory-row"]')].map((row) => row.getAttribute("data-file"));
    if (rows.length !== 2) return false;
    return { rows, count: document.querySelector('[data-testid="memory-count"]')?.textContent?.trim() ?? "" };
  })()`, { timeoutMs: 30_000, label: "memory list after delete" });
  expect(afterDelete).toEqual({ rows: ["gone.md", "stray.md"], count: "2" });
  const indexAfterDelete = await invokeCoworker(app, "coworkers.files.read", { slug: "scout", path: "memory/index.md" });
  expect(indexAfterDelete).toEqual({
    ok: true,
    result: { content: "# Long-term memory index\n\nOne line per durable memory in `memory/long-term/`.\n\n- `long-term/gone.md` — Promoted, then lost\n" },
  });
  const deletedFile = await invokeCoworker(app, "coworkers.files.read", { slug: "scout", path: "memory/long-term/cleaning-day.md" });
  expect(deletedFile).toMatchObject({ ok: false, error: expect.stringContaining("ENOENT") });

  // A file the coworker wrote but never listed can be added to the index from its page.
  await evalIn(app, `document.querySelector('[data-testid="memory-row"][data-file="stray.md"]').click()`);
  await clickButton(app, "Add to index");
  await waitFor(app, `(() => {
    const detail = document.querySelector('[data-testid="memory-detail"][data-file="stray.md"]');
    return detail !== null && !(detail.textContent ?? "").includes("Not in index");
  })()`, { timeoutMs: 30_000, label: "stray memory indexed" });
  const indexAfterAdd = await invokeCoworker(app, "coworkers.files.read", { slug: "scout", path: "memory/index.md" });
  expect(indexAfterAdd).toMatchObject({ ok: true, result: { content: expect.stringContaining("- `long-term/stray.md` — Stray") } });
  evidence.recordAssertionEvidence(
    "Long-term memory is a list of selectable memories, not a raw index file",
    "Memory opened with exactly Soul, Working memory, and Long-term tabs (no per-file tabs) and rendered working memory as a page. Long-term listed three memories from the index joined with the files on disk, marking the missing file and the unlisted one. Selecting Street cleaning rendered its heading, bold Friday, and one list item; Edit exposed the Markdown, a saved edit landed on disk and re-rendered; Delete asked for confirmation, then removed both the file and its index line while leaving the index prose and the other line intact; Add to index listed the stray file.",
    true,
  );
  await evalIn(app, `document.querySelector('button[aria-label="Back to activity"]').click()`);
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-activity-summary"]'))`, { timeoutMs: 30_000, label: "back on Activity" });

  const footerPlacement = await evalIn(app, `(() => {
    const button = document.querySelector('button[title="OpenWork account and settings"]');
    if (!button) return null;
    const rect = button.getBoundingClientRect();
    return { left: rect.left, bottomGap: window.innerHeight - rect.bottom };
  })()`);
  expect(footerPlacement).toMatchObject({
    left: expect.any(Number),
    bottomGap: expect.any(Number),
  });
  if (!isRecord(footerPlacement)) throw new Error("OpenWork footer placement was unavailable.");
  expect(footerPlacement.left).toBeTypeOf("number");
  expect(footerPlacement.bottomGap).toBeTypeOf("number");
  if (typeof footerPlacement.left !== "number" || typeof footerPlacement.bottomGap !== "number") {
    throw new Error("OpenWork footer placement did not contain numeric coordinates.");
  }
  expect(footerPlacement.left).toBeLessThan(32);
  expect(footerPlacement.bottomGap).toBeLessThan(24);

  await evalIn(app, `(() => {
    const shell = document.querySelector('[data-testid="coworker-shell"]');
    if (!(shell instanceof HTMLElement)) throw new Error("Coworker shell was unavailable.");
    shell.dataset.continuityToken = "settings-round-trip";
  })()`);
  await clickButtonContaining(app, "OpenWork");
  await waitForText(app, "OpenWork settings", { timeoutMs: 30_000 });
  const settingsLayout = await evalIn(app, `(() => {
    const shell = document.querySelector('[data-testid="coworker-shell"]');
    const workspace = document.querySelector('[data-testid="coworker-workspace"]');
    const root = document.querySelector('[data-testid="openwork-settings"]');
    const sidebar = document.querySelector('[data-testid="openwork-settings-sidebar"]');
    if (!(shell instanceof HTMLElement) || !(workspace instanceof HTMLElement) || !root || !sidebar) return null;
    const rootRect = root.getBoundingClientRect();
    const sidebarRect = sidebar.getBoundingClientRect();
    return {
      continuityToken: shell.dataset.continuityToken,
      coworkerWorkspaceDisplay: getComputedStyle(workspace).display,
      rootLeft: rootRect.left,
      rootWidth: rootRect.width,
      sidebarLeft: sidebarRect.left,
      sidebarWidth: sidebarRect.width,
      hasVisibleCoworkerContextResizer: (() => {
        const resizer = document.querySelector('[data-testid="context-panel-resizer"]');
        return resizer instanceof HTMLElement && resizer.offsetParent !== null;
      })(),
      visibleRailAvatars: [...document.querySelectorAll("aside nav svg.coworker-avatar")]
        .filter((avatar) => avatar instanceof SVGElement && avatar.getClientRects().length > 0).length,
      railSearchVisible: (() => {
        const search = document.querySelector('input[aria-label="Search coworkers"]');
        return search instanceof HTMLElement && search.offsetParent !== null;
      })(),
      hasSettingsNavigation: sidebar.querySelectorAll('nav button').length,
      navigationLabels: [...sidebar.querySelectorAll('nav button')].map((button) => button.textContent?.trim()),
    };
  })()`);
  expect(settingsLayout).toMatchObject({
    continuityToken: "settings-round-trip",
    coworkerWorkspaceDisplay: "none",
    hasVisibleCoworkerContextResizer: false,
    visibleRailAvatars: 0,
    railSearchVisible: false,
    hasSettingsNavigation: 4,
    navigationLabels: ["General", "Account", "AI models", "AI & local setup"],
  });
  if (
    !isRecord(settingsLayout)
    || typeof settingsLayout.rootLeft !== "number"
    || typeof settingsLayout.rootWidth !== "number"
    || typeof settingsLayout.sidebarLeft !== "number"
    || typeof settingsLayout.sidebarWidth !== "number"
  ) {
    throw new Error("Full-window OpenWork settings layout was unavailable.");
  }
  expect(settingsLayout.rootLeft).toBeLessThan(3);
  expect(settingsLayout.sidebarLeft).toBeLessThan(3);
  expect(settingsLayout.rootWidth).toBeGreaterThan(900);
  expect(settingsLayout.sidebarWidth).toBeGreaterThanOrEqual(240);
  const configurationText = String(await evalIn(app, "document.body.innerText")).toLowerCase();
  expect(configurationText).toContain("local mode");
  expect(configurationText).toContain("ai & local setup");
  expect(configurationText).toContain("opencode/big-pickle");
  expect(configurationText).not.toContain("engine");
  for (const destination of ["AI models", "AI & local setup"]) {
    await clickButton(app, destination);
    const pageText = String(await evalIn(app, "document.body.innerText")).toLowerCase();
    expect(pageText, `${destination} copy`).not.toContain("engine");
    expect(pageText, `${destination} copy`).not.toContain("provider id");
  }
  expect(String(await evalIn(app, `document.querySelector('[data-testid="local-setup-card"]')?.innerText ?? ""`))).toContain("AI is ready");
  expect(String(await evalIn(app, `document.querySelector('[data-testid="local-setup-card"]')?.closest("main")?.innerText ?? ""`))).not.toMatch(/Connect|Disconnect|Add another/);
  // AI models is the same screen as Use this Mac: Found on this Mac, Connected, the free model, Add another — and Disconnect.
  await clickButton(app, "AI models");
  await waitFor(app, `document.querySelector('[data-testid="this-mac-providers"] [data-testid="local-providers"]')?.dataset.loaded === "true" && Boolean(document.querySelector('[data-testid="connected-openai"]'))`, { timeoutMs: 120_000, label: "AI models page ready" });
  const modelsPage = String(await evalIn(app, `document.querySelector('[data-testid="openwork-settings"] main')?.innerText ?? ""`));
  expect(modelsPage).toContain("Found on this Mac".toUpperCase());
  expect(modelsPage).toContain("A free model is ready now");
  expect(modelsPage).toContain("Add another");
  expect(modelsPage).toContain("Use for Scout");
  expectNoFixtureSecret(modelsPage, "the AI models page");
  if (sameMachine) expect(modelsPage).toContain("Stub box");
  evidence.recordAssertionEvidence(
    "Global OpenWork settings open as a full-window workspace with their own left navigation and plain AI language",
    "The discreet bottom-left OpenWork control hid the mounted coworker workspace, its rail, and its context-panel resizer, replacing them with a full-width settings shell, a 252px left settings sidebar, and four destinations named General, Account, AI models, and AI & local setup. The pages showed Local mode, AI is ready, and Scout's selected Big Pickle model without the word engine anywhere.",
    true,
  );

  await clickButtonContaining(app, "Back to coworkers");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-activity-summary"]'))`, { timeoutMs: 30_000, label: "back on Activity" });
  const returnedWorkspace = await evalIn(app, `(() => {
    const shell = document.querySelector('[data-testid="coworker-shell"]');
    const workspace = document.querySelector('[data-testid="coworker-workspace"]');
    if (!(shell instanceof HTMLElement) || !(workspace instanceof HTMLElement)) return null;
    return {
      continuityToken: shell.dataset.continuityToken,
      coworkerWorkspaceDisplay: getComputedStyle(workspace).display,
      selectedCoworker: [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Scout") && Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')),
    };
  })()`);
  expect(returnedWorkspace).toMatchObject({
    continuityToken: "settings-round-trip",
    coworkerWorkspaceDisplay: "flex",
    selectedCoworker: true,
  });
  // Scheduled work is added from Activity › Assignments.
  await openActivityLevel(app, "assignments");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-assignments"]'))`, { timeoutMs: 30_000, label: "the Assignments level" });
  await clickButton(app, "Add assignment");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="add-responsibility"]'))`, { timeoutMs: 30_000, label: "add assignment form" });
  const placementChoice = await evalIn(app, `(() => {
    const radios = [...document.querySelectorAll('[data-testid="add-responsibility"] [role="radio"]')];
    return radios.map((radio) => ({ label: radio.textContent?.trim(), checked: radio.getAttribute("aria-checked") }));
  })()`);
  expect(placementChoice).toEqual([
    { label: "OpenWork Cloud", checked: "false" },
    { label: "This Mac", checked: "true" },
  ]);
  await fill(app, 'input[placeholder="Morning competitor report"]', "Local readiness check");
  await fill(app, 'textarea[placeholder="What should happen on every run?"]', "Reply with exactly LOCAL RESPONSIBILITY READY. Do not use tools.");
  await clickButton(app, "Schedule assignment");
  await waitForText(app, "Local readiness check", { timeoutMs: 30_000 });
  // The row is one plain line a person can read at a glance; the where and the details wait behind it.
  const responsibilityRow = String(await evalIn(app, `document.querySelector('[data-testid="responsibility-row"]')?.innerText ?? ""`));
  expect(responsibilityRow).toContain("Local readiness check");
  expect(responsibilityRow).toContain("Every day at");
  expect(responsibilityRow).toMatch(/Next: (today|tomorrow) at \d{1,2}:\d{2} (AM|PM)/);
  expect(responsibilityRow).not.toMatch(/UTC|America\/|Los_Angeles|slot|thread|Succeeded|Failed|Queued/);
  const responsibilityDetail = String(await waitFor(app, `(() => {
    const toggle = document.querySelector('[data-testid="responsibility-history-toggle"]');
    if (!(toggle instanceof HTMLElement)) return false;
    if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
    const detail = document.querySelector('[data-testid="responsibility-detail"]');
    return detail instanceof HTMLElement ? detail.innerText : false;
  })()`, { timeoutMs: 30_000, label: "responsibility detail" }));
  expect(responsibilityDetail).toContain("When");
  expect(responsibilityDetail).toContain("Where");
  expect(responsibilityDetail).toContain("On this Mac");
  expect(responsibilityDetail).toContain("It hasn't run yet.");
  await evalIn(app, `document.querySelector('[data-testid="responsibility-history-toggle"]').click(); true`);
  expect(String(await evalIn(app, `document.querySelector('[data-testid="responsibility-placement-note"]')?.textContent ?? ""`))).toContain("runs only while Open Coworker is open");
  expect(await evalIn(app, `document.querySelectorAll('[data-testid="responsibility-placement-note"]').length`)).toBe(1);

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

  await waitFor(app, `(() => {
    const menu = document.querySelector('button[aria-label="Actions for Local readiness check"]');
    if (!(menu instanceof HTMLElement)) return false;
    menu.click();
    return true;
  })()`, { label: "responsibility action menu" });
  await waitFor(app, `(() => {
    const item = [...document.querySelectorAll('[role="menuitem"]')].find((candidate) => candidate.textContent?.trim() === "Run now");
    if (!(item instanceof HTMLElement) || item.disabled) return false;
    item.click();
    return true;
  })()`, { label: "Run now menu item" });
  await waitForText(app, "Run started.", { timeoutMs: 30_000 });
  const completedRun = await waitFor(app, `window.__COWORKER__.invoke("localResponsibilities.list", { slug: "scout" })
    .then((response) => {
      const run = response.ok ? response.result?.[0]?.latestRun : null;
      return run?.status === "succeeded" && run.threadId ? run : false;
    })`, {
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
  // The row in Assignments reads the outcome in plain words…
  const rowAfterRun = await waitFor(app, `(() => {
    const row = document.querySelector('[data-testid="responsibility-row"]');
    if (!(row instanceof HTMLElement)) return false;
    const rowText = row.innerText;
    return /Done (today|yesterday) at/.test(rowText) ? rowText : false;
  })()`, { timeoutMs: 30_000, label: "the scheduled assignment's row records the run" });
  expect(String(rowAfterRun)).not.toMatch(/Succeeded|Failed|slot|thread/);
  // …and Activity records it once, in Recent, as work on a schedule; the header alone says Ready.
  await evalIn(app, `document.querySelector('[data-testid="panel-back"]').click()`);
  const sidebarAfterRun = await waitFor(app, `(() => {
    const summary = document.querySelector('[data-testid="coworker-activity-summary"]');
    const recent = document.querySelector('[data-testid="coworker-recent-activity"]');
    const status = document.querySelector('[data-testid="coworker-top-status"]');
    if (!(summary instanceof HTMLElement) || !(recent instanceof HTMLElement) || !(status instanceof HTMLElement)) return false;
    const recentText = recent.innerText;
    if (!recentText.includes("Local readiness check") || !recentText.includes("Done")) return false;
    // The activity read and the scheduled-work read poll independently; wait until both have settled.
    if (status.textContent?.trim() !== "Ready") return false;
    const summaryLines = summary.innerText.split("\\n").map((line) => line.trim()).filter(Boolean);
    if (summaryLines.length !== 0) return false;
    const assignmentsRow = document.querySelector('[data-testid="activity-row-assignments"]');
    return {
      summaryLines,
      recentEntries: recent.querySelectorAll("li").length,
      recentText,
      recentCards: recent.querySelectorAll(".rounded-2xl").length,
      assignmentsRow: assignmentsRow instanceof HTMLElement ? assignmentsRow.innerText.replace(/\\s+/g, " ").trim() : "",
      composerLine: document.querySelector('[data-testid="coworker-summary-line"]')?.textContent?.trim() ?? "",
    };
  })()`, {
    timeoutMs: 30_000,
    label: "Activity records the completed local work",
  });
  expect(sidebarAfterRun).toMatchObject({ summaryLines: [], recentEntries: 1, recentCards: 0, assignmentsRow: "1 assignment On a schedule ›", composerLine: "1 assignment" });
  if (!isRecord(sidebarAfterRun)) throw new Error("Sidebar facts after the run were unavailable.");
  expect(String(sidebarAfterRun.recentText)).toContain("On a schedule");
  evidence.recordAssertionEvidence(
    "A scheduled assignment runs through a native thread and the panel records it once, in the right place",
    "The daily assignment finished with a native ses_ thread id and no error. Its row in Assignments read Done today at a time, the header alone read Ready while the Activity view's now-row stayed empty, its Assignments row read 1 assignment · On a schedule, the composer's summary line read 1 assignment, and Recent listed Local readiness check exactly once, as flat rows, as work on a schedule.",
    true,
  );

  // --- Outcomes live beside the scheduled assignment: a run history with the coworker's own words,
  // and a way to ask the coworker to explain a run without leaving the discussion.
  await openActivityLevel(app, "assignments");
  await waitFor(app, `(() => {
    const toggle = document.querySelector('[data-testid="responsibility-history-toggle"]');
    if (!(toggle instanceof HTMLElement) || !(toggle.textContent ?? "").includes("Done")) return false;
    if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "open the responsibility's details" });
  const history = await waitFor(app, `(() => {
    const runs = [...document.querySelectorAll('[data-testid="responsibility-run"]')];
    if (runs.length !== 1) return false;
    const run = runs[0];
    return {
      outcome: run.getAttribute("data-outcome"),
      text: run.innerText,
      trend: document.querySelector('[data-testid="responsibility-trend"]')?.textContent?.trim() ?? "",
      detail: document.querySelector('[data-testid="responsibility-detail"]')?.innerText ?? "",
      rowSummary: document.querySelector('[data-testid="responsibility-summary"]')?.textContent?.trim() ?? "",
    };
  })()`, { timeoutMs: 30_000, label: "one recorded run in the history" });
  expect(history).toMatchObject({ outcome: "succeeded", trend: "Ran once · done" });
  if (!isRecord(history) || typeof history.text !== "string" || typeof history.rowSummary !== "string" || typeof history.detail !== "string") {
    throw new Error("Run history facts were unavailable.");
  }
  expect(history.detail).toContain("Last time");
  expect(history.detail).toMatch(/Done · (Today|Yesterday) at \d{1,2}:\d{2} (AM|PM) · took \d+ seconds? · started by you/);
  expect(history.detail).not.toMatch(/UTC|America\/|slot|thread|Succeeded/);
  // innerText breaks each flex child onto its own line; read the run as one sentence.
  const runLine = history.text.replace(/\s+/g, " ");
  expect(runLine).toMatch(/Done · (today|yesterday) at .+ · \d+ seconds?/);
  expect(runLine).toContain("Started by you");
  expect(runLine).toContain("Open the conversation");
  expect(runLine).toContain("Ask Scout to explain");
  const summaryRecorded = history.rowSummary.length > 0;
  await waitFor(app, `(() => {
    const explain = document.querySelector('[data-testid="responsibility-explain"]');
    if (!(explain instanceof HTMLElement)) return false;
    explain.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "Ask Scout to explain" });
  const explainDraft = String(await waitFor(app, `(() => {
    const composer = document.querySelector('textarea[aria-label="Message Scout"]');
    return composer instanceof HTMLTextAreaElement && composer.value.includes("Local readiness check") ? composer.value : false;
  })()`, { timeoutMs: 30_000, label: "explain message prefilled in the discussion composer" }));
  expect(explainDraft).toContain('run of your responsibility "Local readiness check". It succeeded.');
  expect(explainDraft).toContain("what the outcome means");
  if (summaryRecorded) expect(explainDraft).toContain("Here is what you reported at the end of that run:");
  expect(await evalIn(app, `[...document.querySelectorAll('[data-message-role="user"]')].length`)).toBe(0);
  evidence.recordAssertionEvidence(
    "Each scheduled assignment shows its run history and can ask the coworker to explain a run",
    `The row read as one plain line and opened into labelled everyday facts (When, Where, Next, Last time) with one run in plain words — Done, when, how long it took, started by you${summaryRecorded ? ", and Scout's own closing summary" : ""} — plus Open the conversation and Ask Scout to explain, with no time-zone ids, slots, threads, or status codes. Explain prefilled the discussion composer with the run's outcome without sending anything.`,
    true,
  );

  // --- A run limit on this Mac: the second request waits in line and starts by itself.
  await clickButtonContaining(app, "OpenWork");
  await waitForText(app, "OpenWork settings", { timeoutMs: 30_000 });
  await clickButton(app, "AI & local setup");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="local-runs-card"] [role="radio"][aria-checked="true"]'))`, { timeoutMs: 30_000, label: "parallel-run limit control" });
  const limitCard = String(await evalIn(app, `document.querySelector('[data-testid="local-runs-card"]')?.innerText ?? ""`));
  expect(limitCard).toContain("Runs on this Mac");
  expect(limitCard).toContain("wait in line");
  expect(limitCard).toMatch(/\d+ running · \d+ waiting/);
  await waitFor(app, `(() => {
    const one = [...document.querySelectorAll('[data-testid="local-runs-card"] [role="radio"]')].find((radio) => radio.textContent?.trim() === "1");
    if (!(one instanceof HTMLElement) || one.disabled) return false;
    one.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "limit of one run" });
  await waitFor(app, `[...document.querySelectorAll('[data-testid="local-runs-card"] [role="radio"]')].find((radio) => radio.textContent?.trim() === "1")?.getAttribute("aria-checked") === "true"`, {
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
  const admissions = await evalIn(app, `Promise.all([
    window.__COWORKER__.invoke("localResponsibilities.runNow", { slug: "scout", id: ${json(longerId)} }),
    window.__COWORKER__.invoke("localResponsibilities.runNow", { slug: "scout", id: ${json(secondId)} }),
  ]).then((results) => window.__COWORKER__.invoke("localResponsibilities.list", { slug: "scout" })
    .then((list) => ({ results, states: list.ok ? list.result.map((item) => [item.name, item.latestRun?.status ?? null, item.latestRun?.queuedAt ?? null]) : null })))`, {
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
  const queuedRow = await waitFor(app, `(() => {
    const row = [...document.querySelectorAll('[data-testid="responsibility-row"]')].find((candidate) => candidate.getAttribute("data-state") === "Queued");
    return row instanceof HTMLElement ? row.innerText : false;
  })()`, { timeoutMs: 30_000, label: "queued responsibility row" });
  expect(String(queuedRow)).toContain("Waiting its turn");
  expect(String(queuedRow)).not.toMatch(/slot|Queued/);
  const drained = await waitFor(app, `window.__COWORKER__.invoke("localResponsibilities.list", { slug: "scout" })
    .then((response) => {
      const items = response.ok ? response.result : [];
      const finished = items.every((item) => item.latestRun?.status === "succeeded");
      return finished ? items.map((item) => ({ name: item.name, runs: item.runs.length, latest: item.latestRun.status, queuedAt: item.latestRun.queuedAt })) : false;
    })`, { awaitPromise: true, timeoutMs: 300_000, label: "both runs succeeded one after another" });
  expect(drained).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: "Longer readiness check", runs: 1, latest: "succeeded", queuedAt: null }),
    expect.objectContaining({ name: "Second readiness check", runs: 1, latest: "succeeded", queuedAt: expect.any(Number) }),
  ]));
  expect(await invokeCoworker(app, "localResponsibilities.status", {})).toMatchObject({ ok: true, result: { limit: 1, active: 0, queued: 0 } });
  evidence.recordAssertionEvidence(
    "A parallel-run limit set in Settings makes later runs wait in line and start by themselves",
    "With Runs on this Mac set to 1, two Run now requests admitted the first immediately and queued the second; the second row read Waiting its turn, then started on its own once the first finished, and both ended done with the queue empty.",
    true,
  );

  if (sameMachine && stub) {
    // --- A coworker answers with the custom server, and Disconnect takes it away again.
    await invokeCoworker(app, "coworkers.update", { slug: "scout", patch: { model: "custom-stub-box/stub-large", modelVariant: "" } });
    await clickButtonContaining(app, "Scout");
    await waitFor(app, `Boolean(document.querySelector('textarea[aria-label="Message Scout"]'))`, { timeoutMs: 30_000, label: "Scout's discussion composer" });
    await fill(app, 'textarea[aria-label="Message Scout"]', "Say hello");
    await clickButton(app, "Send");
    await waitForText(app, STUB_REPLY, { timeoutMs: 180_000 });
    await waitFor(app, `[...document.querySelectorAll('[data-testid="coworker-reply-model"]')].some((line) => (line.textContent ?? "").includes("custom-stub-box/stub-large"))`, { timeoutMs: 30_000, label: "the reply came from the custom server" });
    expect(stub.chatCalls()).toBeGreaterThan(0);
    await clickButtonContaining(app, "OpenWork");
    await waitForText(app, "OpenWork settings", { timeoutMs: 30_000 });
    await clickButton(app, "AI models");
    await waitFor(app, `(() => {
      const disconnect = document.querySelector('[data-testid="connected-custom-stub-box-disconnect"]');
      if (!(disconnect instanceof HTMLElement)) return false;
      disconnect.click();
      return true;
    })()`, { timeoutMs: 120_000, label: "Disconnect the custom server" });
    await waitFor(app, `document.querySelector('[data-testid="local-providers"]')?.dataset.loaded === "true" && !document.querySelector('[data-testid="connected-custom-stub-box"]') && Boolean(document.querySelector('[data-testid="connected-openai"]'))`, { timeoutMs: 120_000, label: "custom server removed" });
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

  // --- Nothing secret left the fixtures: not on screen, not in the app's log.
  expectNoFixtureSecret(String(await evalIn(app, "document.body.innerText")), "the final screen");
  const logPath = app.handle.meta?.log;
  if (sameMachine && typeof logPath === "string") {
    const log = await readFile(logPath, "utf8").catch(() => "");
    expect(log.length).toBeGreaterThan(0);
    expectNoFixtureSecret(log, "the app log");
  }
  evidence.recordAssertionEvidence(
    "Connecting what this Mac already has never shows a secret",
    `The fixture tokens and key (${FIXTURE_SECRETS.length} values) appeared nowhere in the local mode screen, the AI models page, the final screen${sameMachine ? ", or the app's own log" : ""}; only provider names, model counts, and the environment variable's name were shown.`,
    true,
  );

  // --- Scheduling from the chat: asked for recurring work, the coworker sets it up itself through
  // its own assignment tool; the conversation shows exactly what it did, and the panel lists it.
  const scripted = await startScriptedModel();
  const runtimeInfo = await invokeCoworker(app, "runtime.info", {});
  if (!isRecord(runtimeInfo) || !isRecord(runtimeInfo.result)) throw new Error("Runtime info was unavailable.");
  const serverUrl = String(runtimeInfo.result.serverUrl);
  const ownerToken = String(runtimeInfo.result.ownerToken);
  if (!isRecord(storedCoworker) || !isRecord(storedCoworker.result)) throw new Error("Scout's record was unavailable.");
  const scoutWorkspaceId = String(storedCoworker.result.workspaceId);
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
  await evalIn(app, "location.reload(); true");
  // Two coworkers exist now; the app opens on the first, so pick Scout as a person would.
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-rail"]'))`, { timeoutMs: 120_000, label: "team rail after the model change" });
  await clickButtonContaining(app, "Scout");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-discussion-view"]')) && [...document.querySelectorAll("h1")].some((heading) => heading.textContent?.trim() === "Scout")`, { timeoutMs: 120_000, label: "Scout discussion view after the model change" });
  await waitFor(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready"`, { timeoutMs: 240_000, label: "Scout ready on the scripted model" });
  await fill(app, 'textarea[aria-label="Message Scout"]', CAR_PROMPT);
  await clickButton(app, "Send");
  await waitFor(app, `[...document.querySelectorAll('[data-message-role="assistant"]')].some((message) => (message.textContent ?? "").includes(${json(CAR_REPLY)}))`, {
    timeoutMs: 300_000,
    label: "the coworker's confirmation after setting up the assignment",
  });
  const chatScheduling = await waitFor(app, `(() => {
    const line = [...document.querySelectorAll('[data-testid="coworker-action-line"]')].find((candidate) => (candidate.textContent ?? "").includes("Created assignment"));
    const summary = line?.querySelector('[data-testid="coworker-work-summary"]');
    const receipt = line?.querySelector('[data-testid="coworker-work-receipt"]');
    if (!(line instanceof HTMLElement) || !(summary instanceof HTMLElement) || !(receipt instanceof HTMLElement) || receipt.dataset.state !== "done") return false;
    const bubbles = [...document.querySelectorAll('[data-message-role]')];
    const userIndex = bubbles.findIndex((bubble) => (bubble.textContent ?? "").includes(${json(CAR_PROMPT)}));
    const replyIndex = bubbles.findIndex((bubble) => (bubble.textContent ?? "").includes(${json(CAR_REPLY)}));
    const lineTop = line.getBoundingClientRect().top;
    return {
      summary: summary.querySelector("span.truncate")?.textContent?.trim() ?? "",
      state: receipt.dataset.state,
      betweenBubbles: userIndex !== -1 && replyIndex !== -1 && bubbles[userIndex].getBoundingClientRect().bottom <= lineTop && lineTop <= bubbles[replyIndex].getBoundingClientRect().top,
      actionLines: document.querySelectorAll('[data-testid="coworker-action-line"]').length,
      collapsedText: line.innerText,
      appNotes: line.querySelectorAll("iframe").length,
    };
  })()`, { timeoutMs: 60_000, label: "one action line saying what the coworker set up" });
  expect(chatScheduling).toMatchObject({
    summary: "Created assignment · Move the car · Every weekday at 9:00 AM",
    state: "done",
    betweenBubbles: true,
    appNotes: 0,
  });
  if (!isRecord(chatScheduling) || typeof chatScheduling.collapsedText !== "string") throw new Error("Action line facts were unavailable.");
  expect(chatScheduling.collapsedText).not.toMatch(/coworker_|assignment_create|"kind"|\{/);
  // The tool's name waits behind Technical details, never in the line itself. The steps wait in a
  // popover the person opens from the line, so open it only if it is closed.
  await evalIn(app, `(() => {
    const summary = [...document.querySelectorAll('[data-testid="coworker-work-summary"]')].find((button) => (button.textContent ?? "").includes("Created assignment"));
    if (summary instanceof HTMLElement && summary.getAttribute("aria-expanded") !== "true") summary.click();
    return true;
  })()`);
  const technical = String(await waitFor(app, `(() => {
    const step = [...document.querySelectorAll('[data-testid="coworker-work-step"]')].find((candidate) => (candidate.textContent ?? "").includes("Created assignment"));
    const details = step?.querySelector('[data-testid="coworker-work-technical"]');
    return details instanceof HTMLDetailsElement ? details.textContent : false;
  })()`, { timeoutMs: 30_000, label: "technical details of the assignment step" }));
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
  expect(carItem.schedule.timezone).toBe(await evalIn(app, "Intl.DateTimeFormat().resolvedOptions().timeZone"));
  // Scheduled work lives in Activity › Assignments; open it from wherever the panel is.
  await openActivityLevel(app, "assignments");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="coworker-assignments"]'))`, { timeoutMs: 60_000, label: "Assignments for the chat-created assignment" });
  const carRow = String(await waitFor(app, `(() => {
    const row = [...document.querySelectorAll('[data-testid="responsibility-row"]')].find((candidate) => (candidate.textContent ?? "").includes("Move the car"));
    return row instanceof HTMLElement ? row.innerText.replace(/\\s+/g, " ") : false;
  })()`, { timeoutMs: 60_000, label: "the chat-created assignment in the panel" }));
  expect(carRow).toContain("Move the car Every weekday at 9:00 AM");
  expect(carRow).toMatch(/Next: (today|tomorrow|\w+ \d+) at 9:00 AM/);
  expect(carRow).not.toMatch(/UTC|America\/|slot|thread|cron|coworker_/);
  evidence.recordAssertionEvidence(
    "A coworker sets up recurring work itself from the conversation and shows exactly what it did",
    `Asked "${CAR_PROMPT}", Scout called its own assignment tool once (${scripted.requests} model requests), and the conversation showed one action line between the two bubbles reading "Created assignment · Move the car · Every weekday at 9:00 AM" with the tool id only behind Technical details; the assignment was stored as a weekly schedule in the app's own time zone with no zone invented, and the panel listed "Move the car · Every weekday at 9:00 AM" with its next run.`,
    true,
  );

  // --- An interval from the form: every N hours inside a window, with the schedule read back in words.
  await clickButtonContaining(app, "+ Add");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="add-responsibility"]'))`, { timeoutMs: 30_000, label: "add responsibility form for the interval" });
  const intervalForm = await evalIn(app, `(async () => {
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const setNative = (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
      setter?.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const cadence = document.querySelector('select[aria-label="Cadence"]');
    if (!(cadence instanceof HTMLSelectElement)) return null;
    const cadenceOptions = [...cadence.options].map((option) => option.text);
    setNative(cadence, "interval");
    await wait(200);
    const every = document.querySelector('select[aria-label="Every"]');
    const from = document.querySelector('input[aria-label="From"]');
    const until = document.querySelector('input[aria-label="Until"]');
    const perDay = document.querySelector('select[aria-label="Most runs a day"]');
    if (!(every instanceof HTMLSelectElement) || !(from instanceof HTMLInputElement) || !(until instanceof HTMLInputElement) || !(perDay instanceof HTMLSelectElement)) return null;
    setNative(every, "120");
    setNative(from, "09:00");
    setNative(until, "18:00");
    setNative(perDay, "4");
    // Weekdays only: switch Saturday and Sunday off.
    for (const day of ["Saturday", "Sunday"]) document.querySelector('[role="group"][aria-label="Days"] button[aria-label="' + day + '"]')?.click();
    await wait(200);
    return {
      cadenceOptions,
      everyOptions: [...every.options].map((option) => option.text),
      perDayOptions: [...perDay.options].map((option) => option.value),
      days: [...document.querySelectorAll('[role="group"][aria-label="Days"] button')].map((button) => button.getAttribute("aria-pressed")),
      note: document.querySelector('[data-testid="schedule-note"]')?.textContent?.trim() ?? "",
      noteTone: document.querySelector('[data-testid="schedule-note"]')?.getAttribute("data-tone"),
      timeFieldShown: Boolean([...document.querySelectorAll("label")].find((label) => (label.textContent ?? "").startsWith("Time ·"))),
    };
  })()`, { awaitPromise: true, timeoutMs: 30_000 });
  expect(intervalForm).toEqual({
    cadenceOptions: ["Daily", "Weekly", "Every few hours"],
    everyOptions: ["Hour", "2 hours", "3 hours", "4 hours", "6 hours", "8 hours", "12 hours"],
    perDayOptions: ["1", "2", "3", "4"],
    days: ["false", "true", "true", "true", "true", "true", "false"],
    note: "Every 2 hours between 9:00 AM and 6:00 PM on weekdays, up to 4 times a day",
    noteTone: "mist",
    timeFieldShown: false,
  });
  await fill(app, 'input[placeholder="Morning competitor report"]', "Competitor page");
  await fill(app, 'textarea[placeholder="What should happen on every run?"]', "Reply with exactly COMPETITOR PAGE CHECKED. Do not use tools.");
  await clickButton(app, "Schedule assignment");
  const intervalRow = String(await waitFor(app, `(() => {
    const row = [...document.querySelectorAll('[data-testid="responsibility-row"]')].find((candidate) => (candidate.textContent ?? "").includes("Competitor page"));
    return row instanceof HTMLElement ? row.innerText.replace(/\\s+/g, " ") : false;
  })()`, { timeoutMs: 60_000, label: "the interval responsibility in the panel" }));
  expect(intervalRow).toContain("Competitor page Every 2 hours between 9:00 AM and 6:00 PM on weekdays, up to 4 times a day");
  expect(intervalRow).not.toMatch(/UTC|America\/|slot|thread|cron|interval|everyMinutes/);
  const intervalStored = await invokeCoworker(app, "localResponsibilities.list", { slug: "scout" });
  if (!isRecord(intervalStored) || !Array.isArray(intervalStored.result)) throw new Error("Local responsibilities were unavailable after the interval.");
  const intervalItem = intervalStored.result.filter(isRecord).find((item) => item.name === "Competitor page");
  expect(intervalItem).toMatchObject({
    state: "active",
    schedule: { kind: "interval", everyMinutes: 120, from: { hour: 9, minute: 0 }, until: { hour: 18, minute: 0 }, daysOfWeek: [1, 2, 3, 4, 5], maxPerDay: 4 },
    nextDueAt: expect.any(Number),
  });
  // The guardrails a person can set live in AI & local setup with the run limit, whose choices now reach 8.
  await clickButtonContaining(app, "OpenWork");
  await waitForText(app, "OpenWork settings", { timeoutMs: 30_000 });
  await clickButton(app, "AI & local setup");
  const guardrailControls = await waitFor(app, `(() => {
    const limit = document.querySelector('[data-testid="local-runs-limit"]');
    const gap = document.querySelector('[data-testid="minimum-run-gap"]');
    const perDay = document.querySelector('[data-testid="max-runs-per-day"]');
    if (!limit || !gap || !perDay) return false;
    // The card reads its settings first; wait until every group shows its saved choice.
    if ([limit, gap, perDay].some((group) => !group.querySelector('[role="radio"][aria-checked="true"]'))) return false;
    const read = (group) => [...group.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent?.trim() + (radio.getAttribute("aria-checked") === "true" ? "*" : ""));
    return { limit: read(limit), gap: read(gap), perDay: read(perDay), text: document.querySelector('[data-testid="schedule-guardrails"]')?.textContent ?? "" };
  })()`, { timeoutMs: 30_000, label: "guardrail controls" });
  expect(guardrailControls).toMatchObject({
    limit: ["1*", "2", "3", "4", "6", "8"],
    gap: ["15 min", "30 min", "60 min*"],
    perDay: ["1", "2", "4*", "6", "8", "12"],
  });
  if (!isRecord(guardrailControls) || typeof guardrailControls.text !== "string") throw new Error("Guardrail facts were unavailable.");
  expect(guardrailControls.text).toContain("How often one assignment may run");
  expect(guardrailControls.text.toLowerCase()).not.toMatch(/cron|engine|slot/);
  await clickButtonContaining(app, "Back to coworkers");
  evidence.recordAssertionEvidence(
    "The panel form offers an interval with a window, days, and a daily cap, and reads the schedule back in words",
    "Choosing Every few hours revealed the interval fields; the inline note read \"Every 2 hours between 9:00 AM and 6:00 PM on weekdays, up to 4 times a day\" before anything was created, the created row used the same words, the stored schedule kept the window, the weekdays, and the cap, and AI & local setup offered the run limit up to 8 beside the two guardrails (at least 60 minutes apart, at most 4 a day).",
    true,
  );
});
