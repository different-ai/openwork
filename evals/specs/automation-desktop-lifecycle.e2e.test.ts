import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, onTestFinished } from "vitest";
import {
  clickButton,
  clickText,
  createOrgConnection,
  denFetch,
  evalIn,
  go,
  readAvailableModels,
  visibleText,
  waitFor,
  waitForText,
} from "@openwork/behaviors";
import type { DenSession } from "@openwork/behaviors";
import type { Surface } from "@openwork/cdp";
import {
  app,
  eventually,
  mcpMock,
  needs,
  server,
  test,
} from "@openwork/testkit";

const PROVIDER_NAME = "Automation Reliability Gateway";
const PROVIDER_KEY = "automation-reliability-gateway";
const PROVIDER_ENV = "AUTOMATION_RELIABILITY_API_KEY";
const MODEL_ID = "automation-reliability-model";
const MODEL_NAME = "Automation Reliability Model";
const REPLY = "The synthetic Automation lifecycle completed successfully.";
const PROVIDER_API_KEY = "sk-automation-reliability-local-only";
const REQUEST_TIMEOUT_MS = 10_000;
const RUN_TIMEOUT_MS = 180_000;
interface ProviderControl {
  unavailable?: boolean;
  connect?: { capabilityName: string; marker: string };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function auth(session: DenSession): Record<string, string> {
  return { authorization: `Bearer ${session.token}` };
}

function projectedTool(payload: Record<string, unknown>, suffix: string): string | null {
  for (const tool of records(payload.tools)) {
    const fn = isRecord(tool.function) ? tool.function : {};
    if (typeof fn.name === "string" && fn.name.endsWith(suffix)) return fn.name;
  }
  return null;
}

function completedToolCount(payload: Record<string, unknown>): number {
  return records(payload.messages).filter((message) => message.role === "tool").length;
}

function sendProviderStream(
  response: ServerResponse,
  deltas: Array<{ delta: Record<string, unknown>; finishReason?: string | null }>,
  requestNumber: number,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  for (const item of deltas) {
    response.write(`data: ${JSON.stringify({
      id: `chatcmpl-automation-${requestNumber}`,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: item.delta, finish_reason: item.finishReason ?? null }],
    })}\n\n`);
  }
  response.end("data: [DONE]\n\n");
}

function startProviderMock(
  completionBodies: unknown[],
  control: ProviderControl = {},
): Promise<string> {
  const mock = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
      return;
    }
    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      let rawBody = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { rawBody += chunk; });
      request.on("end", () => {
        let body: unknown;
        try {
          body = JSON.parse(rawBody);
        } catch {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "invalid JSON request body" } }));
          return;
        }
        completionBodies.push(body);
        if (control.unavailable) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({
            error: { message: "Synthetic provider is temporarily unavailable", type: "provider_unavailable" },
          }));
          return;
        }
        const payload = isRecord(body) ? body : {};
        if (control.connect && JSON.stringify(payload).includes(control.connect.marker)) {
          const completed = completedToolCount(payload);
          if (completed < 2) {
            const suffix = completed === 0 ? "_search_capabilities" : "_execute_capability";
            const toolName = projectedTool(payload, suffix);
            if (!toolName) {
              response.writeHead(500, { "content-type": "application/json" });
              response.end(JSON.stringify({ error: { message: `missing projected tool ${suffix}` } }));
              return;
            }
            sendProviderStream(response, [
              { delta: { role: "assistant" } },
              {
                delta: {
                  tool_calls: [{
                    index: 0,
                    id: completed === 0 ? "call_automation_search" : "call_automation_echo",
                    type: "function",
                    function: {
                      name: toolName,
                      arguments: completed === 0
                        ? JSON.stringify({ query: "mock echo", type: "mcp", limit: 5 })
                        : JSON.stringify({
                            name: control.connect.capabilityName,
                            body: { text: control.connect.marker },
                          }),
                    },
                  }],
                },
              },
              { delta: {}, finishReason: "tool_calls" },
            ], completionBodies.length);
            return;
          }
        }
        sendProviderStream(response, [
          { delta: { role: "assistant" } },
          { delta: { content: REPLY } },
          { delta: {}, finishReason: "stop" },
        ], completionBodies.length);
      });
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  return new Promise((resolve, reject) => {
    mock.once("error", reject);
    mock.listen(0, "127.0.0.1", () => {
      const address = mock.address();
      if (!address || typeof address === "string") {
        reject(new Error("Automation provider mock did not bind a TCP port."));
        return;
      }
      onTestFinished(async () => {
        await new Promise<void>((closeResolve, closeReject) => {
          mock.close((error) => error ? closeReject(error) : closeResolve());
          mock.closeAllConnections();
        });
      });
      resolve(`http://127.0.0.1:${address.port}/v1`);
    });
  });
}

async function setField(surface: Surface, label: string, value: string): Promise<void> {
  const changed = await evalIn(surface, `(() => {
    const label = [...document.querySelectorAll("label")]
      .find((candidate) => (candidate.textContent ?? "").trim().includes(${JSON.stringify(label)}));
    const id = label?.getAttribute("for");
    const field = id ? document.getElementById(id) : label?.querySelector("input, textarea, select");
    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement)) return false;
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
    setter?.call(field, ${JSON.stringify(value)});
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  })()`);
  expect(changed, `Could not set ${label}`).toBe(true);
}

async function selectAutomationModel(surface: Surface): Promise<void> {
  expect(await evalIn(surface, `(() => {
    const button = document.getElementById("automation-model");
    if (!(button instanceof HTMLButtonElement)) return false;
    button.click();
    return true;
  })()`)).toBe(true);
  await waitFor(surface, `(() => {
    const item = [...document.querySelectorAll("button")]
      .find((candidate) => (candidate.textContent ?? "").includes(${JSON.stringify(MODEL_NAME)})
        && (candidate.textContent ?? "").includes(${JSON.stringify(MODEL_ID)}));
    if (!(item instanceof HTMLElement)) return false;
    item.click();
    return true;
  })()`, { timeoutMs: 30_000, label: "Automation form selected deterministic model" });
}

async function organizationId(session: DenSession): Promise<string> {
  const result = await denFetch(session, "/v1/me/orgs", {
    headers: auth(session),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const organizations = isRecord(result.body) ? records(result.body.orgs) : [];
  const active = organizations.find((organization) => organization.isActive === true) ?? organizations[0];
  const id = active && typeof active.id === "string" ? active.id : "";
  expect(result.response.status, result.text).toBe(200);
  expect(id).not.toBe("");
  return id;
}

async function createProvider(
  admin: DenSession,
  orgId: string,
  baseUrl: string,
  apiKey: string,
): Promise<string> {
  const result = await denFetch(admin, "/v1/llm-providers", {
    method: "POST",
    headers: { ...auth(admin), "x-openwork-org-id": orgId },
    body: JSON.stringify({
      name: PROVIDER_NAME,
      source: "custom",
      customConfig: {
        id: PROVIDER_KEY,
        name: PROVIDER_NAME,
        npm: "@ai-sdk/openai-compatible",
        env: [PROVIDER_ENV],
        api: baseUrl,
        models: [{ id: MODEL_ID, name: MODEL_NAME }],
      },
      apiKey,
      allMembers: true,
      memberIds: [],
      teamIds: [],
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const provider = isRecord(result.body) && isRecord(result.body.llmProvider)
    ? result.body.llmProvider
    : null;
  const id = provider && typeof provider.id === "string" ? provider.id : "";
  expect(result.response.status, result.text).toBe(201);
  expect(id).not.toBe("");
  return id;
}

async function createAutomation(
  admin: DenSession,
  orgId: string,
  input: { name: string; instructions: string; providerId: string },
): Promise<{ automationId: string; revisionId: string }> {
  const result = await denFetch(admin, "/v1/automations", {
    method: "POST",
    headers: { ...auth(admin), "x-openwork-org-id": orgId },
    body: JSON.stringify({
      name: input.name,
      instructions: input.instructions,
      schedule: { kind: "daily", timezone: "UTC", hour: 23, minute: 59 },
      model: { providerId: input.providerId, modelId: MODEL_ID, variant: null },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const automation = isRecord(result.body) && isRecord(result.body.automation)
    ? result.body.automation
    : null;
  const revision = isRecord(result.body) && isRecord(result.body.revision)
    ? result.body.revision
    : null;
  const automationId = automation && typeof automation.id === "string" ? automation.id : "";
  const revisionId = revision && typeof revision.id === "string" ? revision.id : "";
  expect(result.response.status, result.text).toBe(201);
  expect(automation?.state).toBe("active");
  expect(automationId).not.toBe("");
  expect(revisionId).not.toBe("");
  expect(revision?.schedule).toEqual({ kind: "daily", timezone: "UTC", hour: 23, minute: 59 });
  expect(revision?.model).toEqual({ providerId: input.providerId, modelId: MODEL_ID, variant: null });
  return { automationId, revisionId };
}

async function listRuns(admin: DenSession, automationId: string): Promise<Record<string, unknown>[]> {
  const result = await denFetch(admin, `/v1/automations/${encodeURIComponent(automationId)}/runs`, {
    headers: auth(admin),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  expect(result.response.status, result.text).toBe(200);
  return isRecord(result.body) ? records(result.body.items) : [];
}

async function waitForNewRun(
  admin: DenSession,
  automationId: string,
  before: Set<string>,
  trigger: "manual" | "scheduled",
): Promise<Record<string, unknown>> {
  const run = await eventually(async () => {
    const runs = await listRuns(admin, automationId);
    return runs.find((run) => run.trigger === trigger
      && typeof run.id === "string"
      && !before.has(run.id));
  }, {
    within: RUN_TIMEOUT_MS,
    intervalMs: 500,
    label: `new ${trigger} Automation run`,
    until: (run) => isRecord(run),
  });
  if (!run) throw new Error(`The ${trigger} Automation run disappeared after it was observed.`);
  return run;
}

async function waitForTerminalReceipt(
  admin: DenSession,
  runId: string,
): Promise<Record<string, unknown>> {
  return eventually(async () => {
    const result = await denFetch(admin, `/v1/automation-runs/${encodeURIComponent(runId)}`, {
      headers: auth(admin),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    expect(result.response.status, result.text).toBe(200);
    return isRecord(result.body) ? result.body : {};
  }, {
    within: RUN_TIMEOUT_MS,
    intervalMs: 500,
    label: `terminal receipt for ${runId}`,
    until: (receipt) => {
      const run = isRecord(receipt.run) ? receipt.run : null;
      return run !== null && ["succeeded", "failed", "cancelled", "skipped"].includes(String(run.status));
    },
  });
}

async function assertSucceededReceipt(
  receipt: Record<string, unknown>,
  expected: { automationId: string; revisionId?: string; resultText?: string },
): Promise<{ runId: string; sessionId: string }> {
  const run = isRecord(receipt.run) ? receipt.run : {};
  const thread = isRecord(run.executionThread) ? run.executionThread : {};
  const events = records(receipt.events);
  const runId = typeof run.id === "string" ? run.id : "";
  const sessionId = typeof thread.nativeThreadId === "string" ? thread.nativeThreadId : "";
  expect(run.status).toBe("succeeded");
  expect(run.automationId).toBe(expected.automationId);
  if (expected.revisionId) expect(run.revisionId).toBe(expected.revisionId);
  expect(run.error).toBeNull();
  expect(run.resultSummary).toContain(expected.resultText ?? REPLY);
  expect(thread).toMatchObject({
    threadKind: "automation",
    executionLocation: "desktop",
    automationId: expected.automationId,
    automationRunId: runId,
    engineKind: "openwork-desktop-runner-v1",
  });
  expect(sessionId).not.toBe("");
  expect(typeof thread.workspaceId).toBe("string");
  expect(events.map((event) => event.type)).toEqual(["user", "assistant", "usage", "terminal"]);
  expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  return { runId, sessionId };
}

async function openAutomation(surface: Surface, automationId: string, name: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await go(surface, "/automations");
    try {
      await eventually(() => evalIn(surface, "window.location.hash"), {
        within: 30_000,
        intervalMs: 250,
        label: "Automations list route",
        until: (hash) => typeof hash === "string" && /^#\/automations(?:\?|$)/.test(hash),
      });
      await clickText(surface, name, {
        selector: `button[data-automation-id="${automationId}"]`,
        timeoutMs: 30_000,
      });
      await waitForText(surface, "Run now", { timeoutMs: 30_000 });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

async function waitForSyntheticModel(surface: Surface): Promise<void> {
  const availableModels = await eventually(() => readAvailableModels(surface), {
    within: 120_000,
    intervalMs: 2_000,
    label: "synced synthetic Automation model",
    until: (models) => models.some((model) => model.selectable
      && (model.id === MODEL_ID || model.id.endsWith(`/${MODEL_ID}`))),
  });
  expect(availableModels.some((model) => model.selectable
    && (model.id === MODEL_ID || model.id.endsWith(`/${MODEL_ID}`)))).toBe(true);
}

async function triggerManualRun(
  admin: DenSession,
  automationId: string,
): Promise<Record<string, unknown>> {
  const before = new Set((await listRuns(admin, automationId)).flatMap((run) =>
    typeof run.id === "string" ? [run.id] : []));
  const response = await denFetch(admin, `/v1/automations/${encodeURIComponent(automationId)}/run`, {
    method: "POST",
    headers: auth(admin),
  });
  expect(response.response.status, response.text).toBe(202);
  return waitForNewRun(admin, automationId, before, "manual");
}

test("a Desktop Automation completes through UI, API, schedule, thread, and receipt", { timeout: 20 * 60_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS", "OPENWORK_EVAL_AUTOMATIONS_E2E_TEST"], placement: "local" });
  const completionBodies: unknown[] = [];
  const providerControl: ProviderControl = {};
  const providerBaseUrl = await startProviderMock(completionBodies, providerControl);
  await using den = await server({
    place,
    mocks: { connector: mcpMock({ allowUnauthenticatedMcp: true }) },
    org: {
      name: `Automation Reliability ${Date.now()}`,
      admin: { name: "Automation Admin" },
      members: { member: { name: "Automation Member" } },
    },
  });
  const orgId = await organizationId(den.admin);
  const connection = await createOrgConnection(den.admin, {
    name: `Automation echo ${Date.now()}`,
    url: den.mocks.connector.mcpUrl,
    authType: "none",
    credentialMode: "shared",
    access: { orgWide: true },
  });
  const providerId = await createProvider(den.admin, orgId, providerBaseUrl, PROVIDER_API_KEY);
  const stamp = Date.now();
  const automationName = `Synthetic lifecycle ${stamp}`;
  const instructions = `Return one concise synthetic reliability result for marker ${stamp}.`;

  const invalid = await denFetch(den.admin, "/v1/automations", {
    method: "POST",
    headers: { ...auth(den.admin), "x-openwork-org-id": orgId },
    body: JSON.stringify({
      name: `Invalid lifecycle ${stamp}`,
      instructions,
      schedule: { kind: "daily", timezone: "Not/A-Timezone", hour: 9, minute: 0 },
      model: { providerId, modelId: MODEL_ID, variant: null },
    }),
  });
  expect(invalid.response.status).toBe(400);
  expect((await denFetch(den.admin, "/v1/automations", { headers: auth(den.admin) })).text)
    .not.toContain(`Invalid lifecycle ${stamp}`);
  evidence.recordAssertionEvidence(
    "Invalid Automation configuration fails without a runnable record",
    "Den rejected the invalid timezone with HTTP 400 and the invalid name was absent from the owner list.",
    true,
  );

  const created = await createAutomation(den.admin, orgId, {
    name: automationName,
    instructions,
    providerId,
  });
  const denied = await denFetch(den.members.member, `/v1/automations/${encodeURIComponent(created.automationId)}`, {
    headers: auth(den.members.member),
  });
  expect(denied.response.status).toBe(404);
  evidence.recordAssertionEvidence(
    "Automation ownership remains member-scoped",
    "A different organization member received HTTP 404 for the owner's Automation.",
    true,
  );

  await using desktop = await app({ den, as: "admin", place });
  await waitForSyntheticModel(desktop);

  await openAutomation(desktop, created.automationId, automationName);
  const beforeUiRun = new Set((await listRuns(den.admin, created.automationId)).flatMap((run) =>
    typeof run.id === "string" ? [run.id] : []));
  const firstProviderCheckpoint = completionBodies.length;
  await clickButton(desktop, "Run now");
  const uiRun = await waitForNewRun(den.admin, created.automationId, beforeUiRun, "manual");
  const uiRunId = typeof uiRun.id === "string" ? uiRun.id : "";
  const uiReceipt = await waitForTerminalReceipt(den.admin, uiRunId);
  const first = await assertSucceededReceipt(uiReceipt, created);
  const firstRequest = await eventually(() => completionBodies[firstProviderCheckpoint], {
    within: RUN_TIMEOUT_MS,
    intervalMs: 250,
    label: "first synthetic provider completion",
    until: (request) => request !== undefined,
  });
  expect(JSON.stringify(firstRequest)).toContain(String(stamp));
  evidence.recordAssertionEvidence(
    "Run now reaches a real desktop session and durable receipt",
    `UI run ${first.runId} created native thread ${first.sessionId}, returned the deterministic assistant result, and committed four ordered events.`,
    true,
  );

  const receipts: Record<string, unknown>[] = [uiReceipt];
  for (let index = 0; index < 2; index += 1) {
    const before = new Set((await listRuns(den.admin, created.automationId)).flatMap((run) =>
      typeof run.id === "string" ? [run.id] : []));
    const response = await denFetch(den.admin, `/v1/automations/${encodeURIComponent(created.automationId)}/run`, {
      method: "POST",
      headers: auth(den.admin),
    });
    expect(response.response.status, response.text).toBe(202);
    const run = await waitForNewRun(den.admin, created.automationId, before, "manual");
    const runId = typeof run.id === "string" ? run.id : "";
    const receipt = await waitForTerminalReceipt(den.admin, runId);
    await assertSucceededReceipt(receipt, created);
    receipts.push(receipt);
  }

  const scheduledAt = Date.now() + 45_000;
  const scheduleResponse = await denFetch(
    den.admin,
    `/v1/automations/${encodeURIComponent(created.automationId)}`,
    {
      method: "PATCH",
      headers: auth(den.admin),
      body: JSON.stringify({ schedule: { kind: "once", timezone: "UTC", at: scheduledAt } }),
    },
  );
  expect(scheduleResponse.response.status, scheduleResponse.text).toBe(200);
  const scheduledRevision = isRecord(scheduleResponse.body) && isRecord(scheduleResponse.body.revision)
    ? scheduleResponse.body.revision
    : {};
  expect(scheduledRevision.schedule).toEqual({ kind: "once", timezone: "UTC", at: scheduledAt });
  const beforeScheduled = new Set((await listRuns(den.admin, created.automationId)).flatMap((run) =>
    typeof run.id === "string" ? [run.id] : []));
  const scheduledRun = await waitForNewRun(den.admin, created.automationId, beforeScheduled, "scheduled");
  const scheduledRunId = typeof scheduledRun.id === "string" ? scheduledRun.id : "";
  const scheduledReceipt = await waitForTerminalReceipt(den.admin, scheduledRunId);
  await assertSucceededReceipt(scheduledReceipt, {
    automationId: created.automationId,
    revisionId: typeof scheduledRevision.id === "string" ? scheduledRevision.id : undefined,
  });
  receipts.push(scheduledReceipt);

  const runIds = receipts.flatMap((receipt) => {
    const run = isRecord(receipt.run) ? receipt.run : {};
    return typeof run.id === "string" ? [run.id] : [];
  });
  const sessionIds = receipts.flatMap((receipt) => {
    const run = isRecord(receipt.run) ? receipt.run : {};
    const thread = isRecord(run.executionThread) ? run.executionThread : {};
    return typeof thread.nativeThreadId === "string" ? [thread.nativeThreadId] : [];
  });
  expect(new Set(runIds).size).toBe(4);
  expect(new Set(sessionIds).size).toBe(4);
  expect(completionBodies.slice(firstProviderCheckpoint)).toHaveLength(4);
  evidence.recordAssertionEvidence(
    "Repeated and scheduled runs remain exactly-once",
    "Three sequential manual runs and one scheduled occurrence produced four unique runs, four unique native sessions, four deterministic model requests, and four terminal receipts.",
    true,
  );

  const scheduledTerminalRun = isRecord(scheduledReceipt.run) ? scheduledReceipt.run : {};
  const scheduledThread = isRecord(scheduledTerminalRun.executionThread)
    ? scheduledTerminalRun.executionThread
    : {};
  const scheduledThreadId = typeof scheduledThread.id === "string" ? scheduledThread.id : "";
  const scheduledWorkspaceId = typeof scheduledThread.workspaceId === "string" ? scheduledThread.workspaceId : "";
  const scheduledSessionId = typeof scheduledThread.nativeThreadId === "string" ? scheduledThread.nativeThreadId : "";
  const receiptQuery = new URLSearchParams({
    automation: created.automationId,
    run: scheduledRunId,
    thread: scheduledThreadId,
  });
  await go(desktop, `/automations?${receiptQuery.toString()}`);
  await clickText(desktop, "Open local thread", {
    selector: `button[data-automation-run-id="${scheduledRunId}"]`,
    timeoutMs: 30_000,
  });
  await eventually(
    () => evalIn(desktop, "window.location.hash"),
    {
      within: 30_000,
      intervalMs: 250,
      label: "native Automation session route",
      until: (hash) => typeof hash === "string"
        && hash.includes(`/workspace/${encodeURIComponent(scheduledWorkspaceId)}/session/${encodeURIComponent(scheduledSessionId)}`),
    },
  );
  await waitForText(desktop, REPLY, { timeoutMs: 30_000 });
  evidence.recordAssertionEvidence(
    "A receipt opens the actual local execution thread",
    `The scheduled receipt exposed workspace ${scheduledWorkspaceId} and session ${scheduledSessionId}; Open local thread navigated to that session and rendered the deterministic assistant result.`,
    true,
  );

  await openAutomation(desktop, created.automationId, automationName);
  const detailText = await visibleText(desktop);
  expect(detailText).toContain("succeeded");
  expect(detailText).toContain(MODEL_NAME);
  expect(detailText).not.toMatch(/running|waiting|no assistant result/i);
  evidence.recordAssertionEvidence(
    "The Automation UI reflects the terminal result and configured model",
    `The detail view showed succeeded with ${MODEL_NAME}, without a stale running, waiting, or missing-result message.`,
    true,
  );

  const uiName = `UI Connect lifecycle ${Date.now()}`;
  const connectMarker = `automation-connect-${Date.now()}`;
  providerControl.connect = {
    capabilityName: `mcp:${connection.id}:mock_echo`,
    marker: connectMarker,
  };
  await go(desktop, "/automations");
  await clickButton(desktop, "New Automation");
  await waitFor(desktop, "Boolean(document.querySelector('[data-automation-editor]'))", {
    timeoutMs: 30_000,
    label: "Automation create form",
  });
  await setField(desktop, "Name", uiName);
  await setField(
    desktop,
    "Instructions",
    `Use search_capabilities, then execute ${providerControl.connect.capabilityName} with text exactly ${connectMarker}.`,
  );
  await setField(desktop, "Schedule", "daily");
  await setField(desktop, "Time", "23:58");
  await setField(desktop, "Timezone", "UTC");
  await selectAutomationModel(desktop);
  const createScreen = await visibleText(desktop);
  expect(createScreen).toContain("Den keeps the schedule and run history");
  expect(createScreen).toContain("local OpenCode runtime");
  expect(createScreen).not.toMatch(/draft|permission picker|review automation|approve/i);
  await clickButton(desktop, "Create and activate");
  await waitForText(desktop, "Active", { timeoutMs: 60_000 });

  const uiCreated = await eventually(async () => {
    const result = await denFetch(den.admin, "/v1/automations", { headers: auth(den.admin) });
    const items = isRecord(result.body) ? records(result.body.items) : [];
    return items.find((item) => {
      const automation = isRecord(item.automation) ? item.automation : item;
      return automation.name === uiName;
    });
  }, {
    within: 60_000,
    intervalMs: 500,
    label: "UI-created Automation became durable",
    until: (item) => item !== undefined,
  });
  if (!uiCreated) throw new Error("UI-created Automation did not appear in the owner list.");
  const uiAutomation = isRecord(uiCreated.automation) ? uiCreated.automation : uiCreated;
  const uiRevision = isRecord(uiCreated.revision) ? uiCreated.revision : {};
  const uiAutomationId = typeof uiAutomation.id === "string" ? uiAutomation.id : "";
  const uiRevisionId = typeof uiRevision.id === "string" ? uiRevision.id : undefined;
  expect(uiAutomationId).not.toBe("");
  evidence.recordAssertionEvidence(
    "The desktop create form makes an active Automation without a review detour",
    `${uiName} was submitted through the visible form and became active as ${uiAutomationId}.`,
    uiAutomation.state === "active",
  );

  const callsSince = new Date().toISOString();
  await openAutomation(desktop, uiAutomationId, uiName);
  const beforeConnectRun = new Set((await listRuns(den.admin, uiAutomationId)).flatMap((run) =>
    typeof run.id === "string" ? [run.id] : []));
  await clickButton(desktop, "Run now");
  const connectRun = await waitForNewRun(den.admin, uiAutomationId, beforeConnectRun, "manual");
  const connectRunId = typeof connectRun.id === "string" ? connectRun.id : "";
  await assertSucceededReceipt(await waitForTerminalReceipt(den.admin, connectRunId), {
    automationId: uiAutomationId,
    revisionId: uiRevisionId,
    resultText: connectMarker,
  });
  const echoCalls = await den.mocks.connector.toolCalls({
    name: "mock_echo",
    atLeast: 1,
    sinceIso: callsSince,
    timeoutMs: RUN_TIMEOUT_MS,
  });
  const markerCalls = echoCalls.filter((call) => String(call.args.text ?? "").includes(connectMarker));
  expect(markerCalls).toHaveLength(1);
  evidence.recordAssertionEvidence(
    "The UI-created Automation uses its current Connect integration exactly once",
    `mock_echo received one call carrying ${connectMarker}.`,
    markerCalls.length === 1,
  );

  await openAutomation(desktop, uiAutomationId, uiName);
  await clickButton(desktop, "Deactivate");
  await waitForText(desktop, "Inactive", { timeoutMs: 30_000 });
  await waitFor(desktop, `[...document.querySelectorAll("span")].some((label) =>
    label.textContent?.trim() === "Next run" && label.parentElement?.innerText.includes("—"))`, {
    timeoutMs: 30_000,
    label: "deactivation clears the next run",
  });
  await clickButton(desktop, "Activate");
  await waitForText(desktop, "Active", { timeoutMs: 30_000 });
  await waitFor(desktop, `[...document.querySelectorAll("span")].some((label) =>
    label.textContent?.trim() === "Next run" && !label.parentElement?.innerText.includes("—"))`, {
    timeoutMs: 30_000,
    label: "activation recomputes the next run",
  });
  evidence.recordAssertionEvidence(
    "Deactivate clears the next run and Activate recomputes it",
    "The detail page changed to Inactive with an em dash for Next run, then returned to Active with a scheduled occurrence.",
    true,
  );
});

test("a Desktop Automation recovers across restart before execution and while work is queued", { timeout: 20 * 60_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], placement: "local" });
  const completionBodies: unknown[] = [];
  const providerBaseUrl = await startProviderMock(completionBodies);
  await using den = await server({
    place,
    org: {
      name: `Automation Recovery ${Date.now()}`,
      admin: { name: "Automation Recovery Admin" },
    },
  });
  const orgId = await organizationId(den.admin);
  const providerId = await createProvider(den.admin, orgId, providerBaseUrl, PROVIDER_API_KEY);
  const stamp = Date.now();
  const created = await createAutomation(den.admin, orgId, {
    name: `Synthetic recovery ${stamp}`,
    instructions: `Return one concise synthetic recovery result for marker ${stamp}.`,
    providerId,
  });
  const profileDir = await mkdtemp(join(tmpdir(), "openwork-automation-recovery-"));
  onTestFinished(() => rm(profileDir, { recursive: true, force: true }));
  let desktop: Awaited<ReturnType<typeof app>> | null = null;

  try {
    desktop = await app({ den, as: "admin", place, profileDir });
    await waitForSyntheticModel(desktop);
    await desktop.stop();
    desktop = null;

    desktop = await app({ den, as: "admin", place, profileDir });
    await waitForSyntheticModel(desktop);
    const postRestartRun = await triggerManualRun(den.admin, created.automationId);
    const postRestartRunId = typeof postRestartRun.id === "string" ? postRestartRun.id : "";
    const postRestartReceipt = await waitForTerminalReceipt(den.admin, postRestartRunId);
    const first = await assertSucceededReceipt(postRestartReceipt, created);
    evidence.recordAssertionEvidence(
      "Desktop restart before execution preserves runner readiness",
      `The same isolated profile relaunched before execution, reminted its runner authority, and run ${first.runId} completed in native session ${first.sessionId}.`,
      true,
    );

    await desktop.stop();
    desktop = null;
    const providerRequestsBeforeConcurrentRuns = completionBodies.length;
    const concurrentResponses = await Promise.all(Array.from({ length: 3 }, () =>
      denFetch(den.admin, `/v1/automations/${encodeURIComponent(created.automationId)}/run`, {
        method: "POST",
        headers: auth(den.admin),
      })));
    for (const response of concurrentResponses) {
      expect(response.response.status, response.text).toBe(202);
    }
    const concurrentRuns = concurrentResponses.map((response) =>
      isRecord(response.body) && isRecord(response.body.run) ? response.body.run : {});
    expect(concurrentRuns.map((run) => run.status).sort()).toEqual(["queued", "skipped", "skipped"]);
    const queuedConcurrentRun = concurrentRuns.find((run) => run.status === "queued");
    const queuedConcurrentRunId = queuedConcurrentRun && typeof queuedConcurrentRun.id === "string"
      ? queuedConcurrentRun.id
      : "";
    const cancelResponse = await denFetch(
      den.admin,
      `/v1/automation-runs/${encodeURIComponent(queuedConcurrentRunId)}/cancel`,
      { method: "POST", headers: auth(den.admin) },
    );
    const cancelledRun = isRecord(cancelResponse.body) && isRecord(cancelResponse.body.run)
      ? cancelResponse.body.run
      : {};
    expect(cancelResponse.response.status, cancelResponse.text).toBe(200);
    expect(cancelledRun.status).toBe("cancelled");
    expect(cancelledRun.executionThread).toBeNull();
    expect(completionBodies).toHaveLength(providerRequestsBeforeConcurrentRuns);
    evidence.recordAssertionEvidence(
      "Concurrent manual requests overlap safely and cancellation before claim is terminal",
      "Three simultaneous manual requests with Desktop absent produced one queued run and two durable overlap skips; cancelling the queued run returned cancelled with no execution thread and no provider request.",
      true,
    );

    const waitingRun = await triggerManualRun(den.admin, created.automationId);
    const waitingRunId = typeof waitingRun.id === "string" ? waitingRun.id : "";
    expect(waitingRun.status).toBe("queued");

    desktop = await app({ den, as: "admin", place, profileDir });
    const waitingReceipt = await waitForTerminalReceipt(den.admin, waitingRunId);
    const second = await assertSucceededReceipt(waitingReceipt, created);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(completionBodies).toHaveLength(2);
    evidence.recordAssertionEvidence(
      "Queued work survives Desktop absence and relaunch",
      `Run ${second.runId} remained queued while Desktop was stopped; after relaunch a fresh runner credential claimed that same run and exactly one new native session ${second.sessionId} reached a terminal receipt.`,
      true,
    );
  } finally {
    await desktop?.stop();
  }
});

test("a Desktop Automation records a provider outage and succeeds after recovery", { timeout: 10 * 60_000 }, async ({ evidence, place }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"], placement: "local" });
  const completionBodies: unknown[] = [];
  const providerControl = { unavailable: true };
  const providerBaseUrl = await startProviderMock(completionBodies, providerControl);
  await using den = await server({
    place,
    org: {
      name: `Automation Provider Recovery ${Date.now()}`,
      admin: { name: "Automation Provider Recovery Admin" },
    },
  });
  const orgId = await organizationId(den.admin);
  const providerId = await createProvider(den.admin, orgId, providerBaseUrl, PROVIDER_API_KEY);
  const created = await createAutomation(den.admin, orgId, {
    name: `Synthetic provider recovery ${Date.now()}`,
    instructions: "Return a result after the synthetic provider recovers.",
    providerId,
  });
  await using desktop = await app({ den, as: "admin", place });
  await waitForSyntheticModel(desktop);

  const failedRun = await triggerManualRun(den.admin, created.automationId);
  const failedRunId = typeof failedRun.id === "string" ? failedRun.id : "";
  const failedReceipt = await waitForTerminalReceipt(den.admin, failedRunId);
  const failed = isRecord(failedReceipt.run) ? failedReceipt.run : {};
  const failedThread = isRecord(failed.executionThread) ? failed.executionThread : {};
  expect(failed.status).toBe("failed");
  expect(failed.error).toMatchObject({ code: "execution_failed", retryable: false });
  expect(JSON.stringify(failed.error)).toMatch(/temporarily unavailable|503/i);
  expect(typeof failedThread.nativeThreadId).toBe("string");
  expect(typeof failedThread.workspaceId).toBe("string");
  expect(records(failedReceipt.events).map((event) => event.type)).toEqual(["user", "terminal"]);
  evidence.recordAssertionEvidence(
    "A provider outage fails promptly with a linked local execution thread",
    `Run ${failedRunId} received synthetic HTTP 503 responses and reached failed/execution_failed with its native session and workspace preserved; its event sequence ended at terminal instead of remaining running or waiting.`,
    true,
  );

  providerControl.unavailable = false;
  const recoveredRun = await triggerManualRun(den.admin, created.automationId);
  const recoveredRunId = typeof recoveredRun.id === "string" ? recoveredRun.id : "";
  const recoveredReceipt = await waitForTerminalReceipt(den.admin, recoveredRunId);
  const recovered = await assertSucceededReceipt(recoveredReceipt, created);
  expect(recovered.sessionId).not.toBe(failedThread.nativeThreadId);
  evidence.recordAssertionEvidence(
    "A later run succeeds after the provider recovers",
    `Without editing or recreating the Automation, run ${recovered.runId} completed in a new native session after the provider began serving successful responses.`,
    true,
  );
});
