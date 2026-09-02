import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { clickButton, evalIn, fill, waitFor, waitForText } from "@openwork/behaviors";
import { coworker, needs, test } from "@openwork/testkit";
import { expect, onTestFinished } from "vitest";

/**
 * Continue with OpenWork, end to end, without a real account: a deterministic
 * Den stands in for app.openworklabs.com and issues one handoff grant; the
 * organization grants one OpenAI-compatible provider whose model answers with
 * a fixed sentence. The product path under test is the real one — the same
 * handoff exchange, the embedded server's own provider sync, the engine's
 * provider list, and a native discussion turn — only the two remote services
 * are mocked.
 */

const enabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = enabled
  ? "Open Coworker signs in with an OpenWork account and runs a discussion turn on an organization model"
  : "Open Coworker OpenWork account journey skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

const GRANT = "eval-handoff-grant-0001";
const SESSION_TOKEN = "eval-session-token-0001";
const ORG_ID = "org_eval_0001";
const ORG_NAME = "Eval Organization";
const PROVIDER_RECORD_ID = "lpr_eval_org";
const PROVIDER_KEY_ENV = "EVAL_ORG_API_KEY";
const PROVIDER_API_KEY = "eval-org-provider-key-0001";
const MODEL_ID = "eval-org-model";
const MODEL_NAME = "Eval Org Model";
const REPLY = "ACCOUNT MODEL READY";

type Recorded = { method: string; path: string; authorization: string; org: string };

function json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Cannot serialize an undefined browser value.");
  return serialized.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { raw += chunk; });
    request.on("end", () => resolve(raw));
    request.on("error", reject);
  });
}

/** The hosted Den API answers browser origins with CORS; the renderer's exchange call needs the same here. */
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-max-age": "600",
};

function respondJson(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json", ...CORS_HEADERS });
  response.end(JSON.stringify(payload));
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Mock server did not bind a TCP port.");
  return `http://127.0.0.1:${address.port}`;
}

/** Text of the last user message in an OpenAI chat completion request, for the reply router. */
function lastUserText(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.messages)) return "";
  const user = [...body.messages].reverse().find((message) => isRecord(message) && message.role === "user");
  if (!isRecord(user)) return "";
  const content = user.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : "")).join("\n");
  }
  return "";
}

async function invokeCoworker(app: Awaited<ReturnType<typeof coworker>>, command: string, payload: unknown): Promise<unknown> {
  return evalIn(app, `window.__COWORKER__.invoke(${json(command)}, ${json(payload)})`, { awaitPromise: true, timeoutMs: 120_000 });
}

function resultRecord(response: unknown): Record<string, unknown> {
  if (!isRecord(response) || response.ok !== true || !isRecord(response.result)) {
    throw new Error(`Open Coworker bridge returned an unexpected response: ${JSON.stringify(response)}`);
  }
  return response.result;
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

test.skipIf(!enabled)(title, { timeout: 900_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["opencode"] });

  // --- Mock organization model: an OpenAI-compatible endpoint that answers deterministically.
  const completionAuthorizations: string[] = [];
  const model = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      respondJson(response, 200, { object: "list", data: [{ id: MODEL_ID, object: "model" }] });
      return;
    }
    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      void readBody(request).then((raw) => {
        completionAuthorizations.push(request.headers.authorization ?? "");
        let body: unknown = null;
        try { body = JSON.parse(raw); } catch { body = null; }
        const prompt = lastUserText(body);
        const reply = prompt.includes("SECOND") ? `SECOND ${REPLY}` : REPLY;
        const chunks = [
          { id: "chatcmpl-eval", object: "chat.completion.chunk", model: MODEL_ID, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id: "chatcmpl-eval", object: "chat.completion.chunk", model: MODEL_ID, choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] },
          { id: "chatcmpl-eval", object: "chat.completion.chunk", model: MODEL_ID, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
        for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      });
      return;
    }
    respondJson(response, 404, { error: { message: `mock model: no route for ${request.method} ${url}` } });
  });
  const modelBaseUrl = `${await listen(model)}/v1`;

  // --- Mock Den: the handoff exchange plus the member-scoped provider routes the embedded server reads.
  const denRequests: Recorded[] = [];
  const providerRecord = {
    id: PROVIDER_RECORD_ID,
    providerId: "eval-org",
    name: "Eval Org Provider",
    source: "custom",
    updatedAt: "2026-09-01T00:00:00.000Z",
    providerConfig: {
      npm: "@ai-sdk/openai-compatible",
      env: [PROVIDER_KEY_ENV],
      options: { baseURL: modelBaseUrl },
    },
    models: [{ id: MODEL_ID, name: MODEL_NAME, config: { tool_call: false, reasoning: false } }],
  };
  const den = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://den.local");
    // Self-hosted Den is addressed through its /api/den proxy path.
    const path = url.pathname.replace(/^\/api\/den(?=\/|$)/, "");
    if (request.method === "OPTIONS") {
      response.writeHead(204, CORS_HEADERS);
      response.end();
      return;
    }
    const authorization = request.headers.authorization ?? "";
    const org = String(request.headers["x-openwork-legacy-org-id"] ?? request.headers["x-openwork-org-id"] ?? "");
    denRequests.push({ method: request.method ?? "", path, authorization, org });

    if (request.method === "POST" && path === "/v1/auth/desktop-handoff/exchange") {
      void readBody(request).then((raw) => {
        let body: unknown = null;
        try { body = JSON.parse(raw); } catch { body = null; }
        if (!isRecord(body) || body.grant !== GRANT) {
          respondJson(response, 400, { error: "invalid_grant", message: "The sign-in code is missing, expired, or already used." });
          return;
        }
        respondJson(response, 200, {
          token: SESSION_TOKEN,
          user: { name: "Eval Member", email: "member@eval.example" },
          organization: { id: ORG_ID, slug: "eval", name: ORG_NAME },
          connectEnabled: false,
        });
      });
      return;
    }
    if (authorization !== `Bearer ${SESSION_TOKEN}`) {
      respondJson(response, 401, { error: "unauthorized", message: "Missing or invalid session token." });
      return;
    }
    if (request.method === "GET" && path === "/v1/me/orgs") {
      respondJson(response, 200, { orgs: [{ id: ORG_ID, name: ORG_NAME }], activeOrgId: ORG_ID });
      return;
    }
    if (request.method === "GET" && path === "/v1/llm-providers") {
      respondJson(response, 200, { llmProviders: [providerRecord] });
      return;
    }
    if (request.method === "GET" && path === `/v1/llm-providers/${PROVIDER_RECORD_ID}/connect`) {
      respondJson(response, 200, {
        llmProvider: { ...providerRecord, apiKey: PROVIDER_API_KEY, apiKeys: null, memberCredential: { state: "active" } },
      });
      return;
    }
    if (request.method === "GET" && path === "/v1/automations") {
      respondJson(response, 200, { items: [], nextCursor: null });
      return;
    }
    respondJson(response, 404, { error: "not_found", message: `mock Den: no route for ${request.method} ${path}` });
  });
  const denBaseUrl = await listen(den);

  await using app = await coworker({ name: "openwork-account", env: { COWORKER_DEN_BASE_URL: denBaseUrl } });

  // --- First run: choose the account path and complete the handoff by pasting the link Den would show.
  await waitFor(app, `(document.body?.innerText ?? "").toLowerCase().includes("welcome to open coworker")`, {
    timeoutMs: 120_000,
    label: "Open Coworker welcome screen",
  });
  await waitFor(app, `(() => {
    const choice = document.querySelector('[data-testid="onboarding-cloud-choice"]');
    if (!choice) return false;
    choice.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "Continue with OpenWork choice" });
  await waitForText(app, "Continue with OpenWork", { timeoutMs: 30_000 });
  await waitFor(app, `Boolean(document.querySelector('[data-testid="sign-in-gate"]'))`, { timeoutMs: 30_000, label: "sign-in gate" });
  const gateText = String(await evalIn(app, "document.body.innerText"));
  expect(gateText).toContain("Open OpenWork sign-in");
  expect(gateText.toLowerCase()).toContain("paste sign-in link");
  expect(gateText).toContain("same OpenWork account you use in OpenWork Desktop");
  expect(await evalIn(app, `document.querySelector('[data-testid="sign-in-gate"] input')?.placeholder ?? ""`)).toContain("opencoworker://den-auth");

  await fill(
    app,
    'input[placeholder^="opencoworker://den-auth"]',
    `opencoworker://den-auth?grant=${GRANT}&denBaseUrl=${encodeURIComponent(denBaseUrl)}`,
  );
  await clickButton(app, "Connect");

  // The exchange happened against the mock Den and the account moved on to coworker creation.
  await waitForText(app, "Add a coworker", { timeoutMs: 120_000 });
  expect(denRequests.some((entry) => entry.method === "POST" && entry.path === "/v1/auth/desktop-handoff/exchange")).toBe(true);
  // The embedded server, not the renderer, read the organization's providers with the session it was handed
  // (sign-in awaits that sync before it moves on to coworker creation).
  const providerReads = denRequests.filter((entry) => entry.path === "/v1/llm-providers" || entry.path.endsWith("/connect"));
  expect(providerReads.length).toBeGreaterThanOrEqual(2);
  expect(providerReads.every((entry) => entry.authorization === `Bearer ${SESSION_TOKEN}` && entry.org === ORG_ID)).toBe(true);
  const storedSession = await evalIn(app, `(() => {
    const raw = window.localStorage.getItem("coworker.den.session.v1");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return { orgName: parsed.orgName, userEmail: parsed.userEmail, hasToken: typeof parsed.token === "string" && parsed.token.length > 0 };
  })()`);
  expect(storedSession).toEqual({ orgName: ORG_NAME, userEmail: "member@eval.example", hasToken: true });

  evidence.recordAssertionEvidence(
    "Continue with OpenWork completes the real desktop handoff and hands the account to the embedded server",
    `The pasted ${"opencoworker://den-auth"} link was exchanged at /v1/auth/desktop-handoff/exchange, the session persisted for ${ORG_NAME}, and the embedded server fetched the member's providers (${providerReads.length} authenticated reads) before any coworker existed.`,
    true,
  );

  // --- Create the first coworker; its model step must offer the organization model, labelled as OpenWork Cloud.
  await fill(app, 'input[placeholder="Scout"]', "Scout");
  await clickButton(app, "Add coworker", { timeoutMs: 120_000 });
  await waitForText(app, "Choose a model", { timeoutMs: 120_000 });
  await waitForText(app, "Your organization's OpenWork models are listed first", { timeoutMs: 30_000 });
  await waitFor(app, `Boolean(document.querySelector('[data-testid="model-provider-${PROVIDER_RECORD_ID}"]'))`, {
    timeoutMs: 180_000,
    label: "organization provider group in the model picker",
  });
  const pickerFacts = await evalIn(app, `(() => {
    const group = document.querySelector('[data-testid="model-provider-${PROVIDER_RECORD_ID}"]');
    return {
      groupText: group?.textContent ?? "",
      cloudTagInGroup: Boolean(group?.querySelector('[data-testid="model-source-cloud"]')),
      summary: document.querySelector('[data-testid="model-picker-summary"]')?.textContent ?? "",
    };
  })()`);
  expect(pickerFacts).toMatchObject({ cloudTagInGroup: true });
  if (!isRecord(pickerFacts) || typeof pickerFacts.groupText !== "string" || typeof pickerFacts.summary !== "string") {
    throw new Error("Model picker facts were unavailable.");
  }
  expect(pickerFacts.groupText).toContain("Eval Org Provider");
  expect(pickerFacts.groupText).toContain(MODEL_NAME);
  expect(pickerFacts.summary).toContain("come from your OpenWork account");
  expect(pickerFacts.summary).toContain(ORG_NAME);

  await clickButtonContaining(app, MODEL_NAME);
  await waitForText(app, `Eval Org Provider · ${MODEL_ID} · OpenWork Cloud`, { timeoutMs: 30_000 });
  await clickButton(app, "Finish setup");
  await waitForText(app, "Discussion with Scout", { timeoutMs: 120_000 });
  const scout = resultRecord(await invokeCoworker(app, "coworkers.get", { slug: "scout" }));
  expect(scout.model).toBe(`${PROVIDER_RECORD_ID}/${MODEL_ID}`);

  evidence.recordAssertionEvidence(
    "The organization's model reaches the coworker model step through the engine, labelled by source",
    `After sign-in the picker grouped ${MODEL_NAME} under Eval Org Provider with an OpenWork Cloud tag and a summary naming ${ORG_NAME}; selecting it persisted ${PROVIDER_RECORD_ID}/${MODEL_ID} on Scout.`,
    true,
  );

  // --- A real discussion turn on that model, with the credential delivered by the server, not the UI.
  const prompt = `Reply with exactly ${REPLY}.`;
  await fill(app, 'textarea[aria-label="Message Scout"]', prompt);
  await clickButton(app, "Send");
  const reply = await waitFor(app, `(() => {
    const message = [...document.querySelectorAll('[data-message-role="assistant"]')]
      .find((candidate) => (candidate.textContent ?? "").includes(${json(REPLY)}));
    return message?.textContent ?? false;
  })()`, { timeoutMs: 300_000, label: "assistant reply from the organization model" });
  expect(String(reply)).toContain(REPLY);
  const replyModel = await waitFor(app, `document.querySelector('[data-testid="coworker-reply-model"]')?.textContent ?? false`, {
    timeoutMs: 30_000,
    label: "answering model attribution",
  });
  expect(String(replyModel)).toContain(MODEL_ID);
  expect(completionAuthorizations.length).toBeGreaterThanOrEqual(1);
  expect(completionAuthorizations.every((value) => value === `Bearer ${PROVIDER_API_KEY}`)).toBe(true);
  await waitFor(app, `document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready"`, {
    timeoutMs: 60_000,
    label: "coworker settles to Ready after a matched reply",
  });

  evidence.recordAssertionEvidence(
    "A discussion turn runs on the organization model with the account's credential and is attributed honestly",
    `Scout answered "${REPLY}" through ${PROVIDER_RECORD_ID}/${MODEL_ID}; the mock provider saw ${completionAuthorizations.length} completion request(s), each authorized with the credential Den granted, and the reply carried the model attribution before the thread reported Ready.`,
    true,
  );

  // --- Reload: account, providers, and selection all persist; settings explain the source of every provider.
  await evalIn(app, "location.reload(); true");
  await waitForText(app, "Discussion with Scout", { timeoutMs: 120_000 });
  await waitForText(app, REPLY, { timeoutMs: 60_000 });
  await clickButtonContaining(app, ORG_NAME);
  await waitForText(app, "OpenWork settings", { timeoutMs: 30_000 });
  await clickButton(app, "Account");
  await waitFor(app, `document.querySelector('[data-testid="account-status"]')?.textContent === "OpenWork connected"`, {
    timeoutMs: 30_000,
    label: "connected account status",
  });
  const accountText = String(await evalIn(app, `document.querySelector('[data-testid="account-card"]')?.innerText ?? ""`));
  expect(accountText).toContain(ORG_NAME);
  expect(accountText).toContain("member@eval.example");
  expect(accountText).not.toContain(SESSION_TOKEN);
  await clickButton(app, "Models & providers");
  await waitFor(app, `Boolean(document.querySelector('[data-testid="cloud-providers"]'))`, { timeoutMs: 60_000, label: "OpenWork Cloud provider group" });
  const modelsText = String(await evalIn(app, "document.body.innerText"));
  expect(modelsText).toContain("Eval Org Provider");
  expect(modelsText).toContain(PROVIDER_RECORD_ID);
  expect(modelsText).not.toContain(PROVIDER_API_KEY);

  evidence.recordAssertionEvidence(
    "Account and provider state survive reload and are explained without exposing secrets",
    "After reload the discussion and reply were still present, Account showed OpenWork connected with the organization and member, and Models & providers listed the organization provider under OpenWork Cloud. Neither the session token nor the provider key appeared on screen.",
    true,
  );

  // --- Sign out: the server sweeps the account's providers, and the saved model becomes visibly unavailable.
  await clickButton(app, "Account");
  await clickButton(app, "Sign out");
  await waitFor(app, `document.querySelector('[data-testid="account-status"]')?.textContent === "Local mode"`, {
    timeoutMs: 60_000,
    label: "signed-out account status",
  });
  expect(await evalIn(app, `window.localStorage.getItem("coworker.den.session.v1")`)).toBeNull();
  await clickButton(app, "Models & providers");
  // The sweep reloads the engine asynchronously; re-read the catalog until the account group is gone.
  const sweepDeadline = Date.now() + 180_000;
  for (;;) {
    const swept = await evalIn(app, `(() => {
      const body = document.body.innerText;
      return !document.querySelector('[data-testid="cloud-providers"]')
        && !body.includes("Reading OpenWork models")
        && (Boolean(document.querySelector('[data-testid="local-providers"]'))
          || body.includes("No connected provider models are available"));
    })()`);
    if (swept === true) break;
    if (Date.now() > sweepDeadline) throw new Error("Organization providers were still listed 180s after sign-out.");
    await clickButton(app, "Refresh", { timeoutMs: 30_000 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  await clickButtonContaining(app, "Back to coworkers");
  await waitForText(app, "Discussion with Scout", { timeoutMs: 60_000 });
  await fill(app, 'textarea[aria-label="Message Scout"]', "Reply with exactly SIGNED OUT.");
  await clickButton(app, "Send");
  const failureText = String(await waitFor(app, `document.querySelector('[data-testid="coworker-turn-failed"]')?.textContent ?? false`, {
    timeoutMs: 120_000,
    label: "visible failure for the now-unavailable organization model",
  }));
  expect(failureText).toContain(`${PROVIDER_RECORD_ID}/${MODEL_ID}`);
  expect(failureText).toContain("no OpenWork account is signed in");
  expect(failureText).toContain("Continue with OpenWork");
  expect(failureText).toContain("Open model settings");

  evidence.recordAssertionEvidence(
    "Signing out removes the organization's providers and turns the saved model into an actionable failure",
    `After Sign out the settings showed Local mode with no OpenWork Cloud group, and the next discussion turn failed visibly naming ${PROVIDER_RECORD_ID}/${MODEL_ID}, explaining that no account is signed in, with Continue with OpenWork and Open model settings actions.`,
    true,
  );
});
