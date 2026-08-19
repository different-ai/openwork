import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { expect, onTestFinished } from "vitest";
import {
  control,
  createAndSelectWorkspace,
  evalIn,
  selectModel,
  waitFor,
} from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/test-evidence";
import { desktop, localHost } from "@openwork/hosts";
import { eventually, needs, test } from "@openwork/testkit";

const providerId = "engine-restart-freshness-mock";
const modelId = "engine-restart-freshness-model";
const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "multiple sessions generate fresh replies after the bundled engine restarts"
  : "engine restart turn freshness skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

interface TranscriptMessage {
  role: string;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function newestSessionId(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0 || !isRecord(value[0]) || typeof value[0].sessionId !== "string") {
    throw new Error(`session.list_sessions did not return a newest session: ${JSON.stringify(value)}`);
  }
  return value[0].sessionId;
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(contentText).filter(Boolean).join("\n");
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  return contentText(value.content);
}

function requestMessages(value: unknown): TranscriptMessage[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) return [];
  return value.messages.flatMap((message) => {
    if (!isRecord(message) || typeof message.role !== "string") return [];
    return [{ role: message.role, text: contentText(message.content) }];
  });
}

function requestContains(value: unknown, text: string): boolean {
  return requestMessages(value).some((message) => message.text.includes(text));
}

function requestSnippet(value: unknown): string {
  return JSON.stringify(requestMessages(value).filter((message) => message.role === "user" || message.role === "assistant"));
}

function parseTranscript(value: unknown, sessionId: string): TranscriptMessage[] {
  if (!isRecord(value) || value.sessionId !== sessionId || !Array.isArray(value.messages)) {
    throw new Error(`Unreadable transcript for ${sessionId}: ${JSON.stringify(value)}`);
  }
  return value.messages.flatMap((message) => {
    if (!isRecord(message) || typeof message.role !== "string" || typeof message.text !== "string") return [];
    return [{ role: message.role, text: message.text }];
  });
}

function assistantHasText(text: string): string {
  return `(() => [...document.querySelectorAll('[data-message-role="assistant"]')]
    .some((message) => (message.innerText ?? "").includes(${JSON.stringify(text)})))()`;
}

function routeHasSession(sessionId: string): string {
  return `(() => {
    const parts = window.__openworkControl.snapshot().route.split("/");
    const index = parts.indexOf("session");
    return index >= 0 && decodeURIComponent(parts[index + 1] ?? "") === ${JSON.stringify(sessionId)};
  })()`;
}

async function openSession(app: Awaited<ReturnType<typeof desktop>>, sessionId: string): Promise<void> {
  await control(app, "session.open", { sessionId }, { timeoutMs: 30_000 });
  await waitFor(app, routeHasSession(sessionId), {
    timeoutMs: 60_000,
    label: `route reached session ${sessionId}`,
  });
  await waitFor(app, `window.__openworkControl.listActions().some((action) =>
    action.id === "session.read_transcript" && !action.disabled)`, {
    timeoutMs: 60_000,
    label: `transcript control ready for session ${sessionId}`,
  });
}

async function readTranscript(app: Awaited<ReturnType<typeof desktop>>, sessionId: string): Promise<TranscriptMessage[]> {
  return parseTranscript(
    await control(app, "session.read_transcript", { count: 30 }, { timeoutMs: 30_000 }),
    sessionId,
  );
}

async function sendMessage(app: Awaited<ReturnType<typeof desktop>>, text: string): Promise<void> {
  await waitFor(app, `window.__openworkControl.listActions().some((action) =>
    action.id === "composer.set_text" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "composer text action enabled",
  });
  await control(app, "composer.set_text", { text }, { timeoutMs: 30_000 });
  await waitFor(app, `window.__openworkControl.listActions().some((action) =>
    action.id === "composer.send" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "composer send action enabled",
  });
  await control(app, "composer.send", undefined, { timeoutMs: 30_000 });
}

async function waitForCompletionCall(completionBodies: unknown[], count: number, probe: string): Promise<void> {
  await eventually(() => completionBodies.length, {
    within: 30_000,
    label: `completion request ${count} for ${probe}`,
    until: (observed) => observed >= count,
  });
  expect(requestContains(completionBodies[count - 1], probe), requestSnippet(completionBodies[count - 1])).toBe(true);
}

function assertTranscript(
  messages: TranscriptMessage[],
  firstProbe: string,
  secondProbe: string,
  otherFirstProbe: string,
  otherSecondProbe: string,
): void {
  expect(messages.filter((message) => message.role === "user"), JSON.stringify(messages)).toHaveLength(2);
  expect(messages.filter((message) => message.role === "assistant"), JSON.stringify(messages)).toHaveLength(2);
  expect(messages, JSON.stringify(messages)).toHaveLength(4);
  const text = messages.map((message) => message.text).join("\n");
  expect(text).toContain(`fresh-reply:${firstProbe}`);
  expect(text).toContain(`fresh-reply:${secondProbe}`);
  expect(text).not.toContain(`fresh-reply:${otherFirstProbe}`);
  expect(text).not.toContain(`fresh-reply:${otherSecondProbe}`);
  const secondUserIndex = messages.findIndex((message) => message.role === "user" && message.text.includes(secondProbe));
  const secondReplyIndex = messages.findIndex((message) => message.role === "assistant" && message.text.includes(`fresh-reply:${secondProbe}`));
  expect(secondUserIndex, `${secondProbe} user turn missing from ${JSON.stringify(messages)}`).toBeGreaterThanOrEqual(0);
  expect(secondReplyIndex, `${secondProbe} reply missing from ${JSON.stringify(messages)}`).toBeGreaterThan(secondUserIndex);
}

test.skipIf(!e2eTestsEnabled)(title, { timeout: 600_000 }, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  const runId = Date.now();
  const p1a = `P1a-${runId}`;
  const p1b = `P1b-${runId}`;
  const p2a = `P2a-${runId}`;
  const p2b = `P2b-${runId}`;
  const probes = [p1a, p1b, p2a, p2b];
  const completionBodies: unknown[] = [];

  const mock = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
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
        const messages = requestMessages(body);
        const lastUser = [...messages].reverse().find((message) => message.role === "user");
        const probe = probes.find((candidate) => lastUser?.text.includes(candidate));
        if (!probe) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: `last user message had no freshness probe: ${lastUser?.text ?? "missing"}` } }));
          return;
        }
        const reply = `fresh-reply:${probe}`;
        const chunks = [
          { id: `chatcmpl-${probe}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id: `chatcmpl-${probe}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] },
          { id: `chatcmpl-${probe}`, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ];
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          connection: "keep-alive",
        });
        for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
        response.write("data: [DONE]\n\n");
        response.end();
      });
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "not found" } }));
  });
  await new Promise<void>((resolve, reject) => {
    mock.once("error", reject);
    mock.listen(0, "127.0.0.1", resolve);
  });
  onTestFinished(async () => {
    await new Promise<void>((resolve, reject) => mock.close((error) => error ? reject(error) : resolve()));
  });
  const address = mock.address();
  if (!address || typeof address === "string") throw new Error("Mock provider did not bind a TCP port.");
  const baseUrl = `http://127.0.0.1:${address.port}/v1`;

  const profileDir = `/tmp/openwork-engine-restart-freshness-${process.pid}-${runId}`;
  const workspacePath = `${profileDir}/continuity-workspace`;
  onTestFinished(async () => rm(profileDir, { recursive: true, force: true }));
  await using host = localHost();

  let workspaceId = "";
  let s1 = "";
  let s2 = "";
  const firstApp = await desktop({ name: "engine-restart-turn-freshness", host, profileDir });
  try {
    const workspace = await createAndSelectWorkspace(firstApp, { path: workspacePath });
    workspaceId = workspace.workspaceId;

    const versionRaw = await evalIn(firstApp, `(async () => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      if (!port || !token) return "missing local server credentials";
      const response = await fetch("http://127.0.0.1:" + port + "/status", {
        headers: { Authorization: "Bearer " + token },
      });
      if (!response.ok) return "status failed: " + response.status + " " + (await response.text()).slice(0, 500);
      const body = await response.json();
      return typeof body.opencodeVersion === "string" ? body.opencodeVersion : "missing opencodeVersion: " + JSON.stringify(body);
    })()`, { awaitPromise: true, timeoutMs: 30_000 });
    const engineVersion = String(versionRaw).replace(/^v/, "");
    evidence.recordAssertionEvidence(
      "The local OpenWork server reports the fixed bundled OpenCode engine",
      `GET /status observed ${JSON.stringify({ opencodeVersion: versionRaw })}.`,
      engineVersion === "1.18.18" && !engineVersion.startsWith("1.17."),
    );
    expect(engineVersion, `stale 1.17.x engine reported by /status: ${engineVersion}`).not.toMatch(/^1\.17\./);
    expect(engineVersion).toBe("1.18.18");

    const configured = await evalIn(firstApp, `(async () => {
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
              [${JSON.stringify(providerId)}]: {
                npm: "@ai-sdk/openai-compatible",
                name: "Engine restart freshness mock",
                options: { baseURL: ${JSON.stringify(baseUrl)}, apiKey: "sk-engine-restart-freshness" },
                models: { [${JSON.stringify(modelId)}]: { name: "Engine restart freshness model" } },
              },
            },
          },
        }),
      });
      if (patched !== "ok") return patched;
      const reloaded = await request("/workspace/" + encodeURIComponent(workspaceId) + "/engine/reload", { method: "POST" });
      if (reloaded !== "ok") return reloaded;
      const raw = localStorage.getItem("openwork.preferences");
      let preferences = {};
      try { preferences = raw ? JSON.parse(raw) : {}; } catch { preferences = {}; }
      if (!preferences || typeof preferences !== "object" || Array.isArray(preferences)) preferences = {};
      localStorage.setItem("openwork.preferences", JSON.stringify({
        ...preferences,
        defaultModel: { providerID: ${JSON.stringify(providerId)}, modelID: ${JSON.stringify(modelId)} },
        modelVariant: null,
        providerStepCompleted: true,
      }));
      localStorage.setItem("openwork.defaultModel", ${JSON.stringify(`${providerId}/${modelId}`)});
      localStorage.removeItem("openwork.sessionModels." + workspaceId);
      return "ok";
    })()`, { awaitPromise: true, timeoutMs: 30_000 });
    expect(configured).toBe("ok");
    const selectedModel = await selectModel(firstApp, modelId);
    expect(selectedModel.id).toBe(modelId);
    expect(selectedModel.providerName).toContain("Engine restart freshness mock");

    await control(firstApp, "session.create_task", undefined, { timeoutMs: 30_000 });
    s1 = newestSessionId(await control(firstApp, "session.list_sessions"));
    await control(firstApp, "session.rename", { sessionId: s1, title: `Freshness S1 ${runId}` }, { timeoutMs: 30_000 });
    await sendMessage(firstApp, `freshness probe ${p1a}`);
    await waitForCompletionCall(completionBodies, 1, p1a);
    await waitFor(firstApp, assistantHasText(`fresh-reply:${p1a}`), {
      timeoutMs: 120_000,
      label: `pre-restart assistant reply for ${p1a}`,
    }).catch((error: unknown) => {
      throw new Error(`P1a did not render; completion requests=${JSON.stringify(completionBodies.map(requestSnippet))}`, { cause: error });
    });

    await control(firstApp, "session.create_task", undefined, { timeoutMs: 30_000 });
    s2 = newestSessionId(await control(firstApp, "session.list_sessions"));
    expect(s2).not.toBe(s1);
    await control(firstApp, "session.rename", { sessionId: s2, title: `Freshness S2 ${runId}` }, { timeoutMs: 30_000 });
    await sendMessage(firstApp, `freshness probe ${p2a}`);
    await waitForCompletionCall(completionBodies, 2, p2a);
    await waitFor(firstApp, assistantHasText(`fresh-reply:${p2a}`), {
      timeoutMs: 120_000,
      label: `pre-restart assistant reply for ${p2a}`,
    });

    expect(completionBodies, completionBodies.map(requestSnippet).join("\n")).toHaveLength(2);
    expect(requestContains(completionBodies[0], p1a), requestSnippet(completionBodies[0])).toBe(true);
    expect(requestContains(completionBodies[0], p2a), requestSnippet(completionBodies[0])).toBe(false);
    expect(requestContains(completionBodies[1], p2a), requestSnippet(completionBodies[1])).toBe(true);
    expect(requestContains(completionBodies[1], p1a), requestSnippet(completionBodies[1])).toBe(false);
    evidence.recordAssertionEvidence(
      "Before restart, two real sessions each made exactly one isolated completion call",
      `Observed completion request messages: ${JSON.stringify(completionBodies.map(requestSnippet))}.`,
      true,
    );

    const preRestartShot = await screenshot(firstApp);
    const preRestartSeen = await validate(preRestartShot, [
      `The current session shows the user probe '${p2a}' followed by assistant reply 'fresh-reply:${p2a}'`,
      `No reply containing 'fresh-reply:${p1a}' is visible in the current session`,
      "No error dialog or crash message is visible",
    ]);
    expect(preRestartSeen.ok, preRestartSeen.why).toBe(true);
  } finally {
    await firstApp.stop();
  }

  const restartedApp = await desktop({ name: "engine-restart-turn-freshness", host, profileDir });
  try {
    await waitFor(restartedApp, `(async () => {
      const port = localStorage.getItem("openwork.server.port");
      const token = localStorage.getItem("openwork.server.token");
      if (!port || !token) return false;
      try {
        const response = await fetch("http://127.0.0.1:" + port + "/status", {
          headers: { Authorization: "Bearer " + token },
        });
        return response.ok;
      } catch {
        return false;
      }
    })()`, {
      awaitPromise: true,
      timeoutMs: 120_000,
      label: "restarted local OpenWork server ready",
    });
    const reopenedWorkspace = await createAndSelectWorkspace(restartedApp, { path: workspacePath });
    expect(reopenedWorkspace.workspaceId).toBe(workspaceId);

    await openSession(restartedApp, s1);
    await waitFor(restartedApp, assistantHasText(`fresh-reply:${p1a}`), {
      timeoutMs: 60_000,
      label: `persisted pre-restart reply for ${p1a}`,
    });
    const persistedS1 = await readTranscript(restartedApp, s1);
    expect(persistedS1.map((message) => message.text).join("\n")).toContain(p1a);
    expect(persistedS1.map((message) => message.text).join("\n")).toContain(`fresh-reply:${p1a}`);
    evidence.recordAssertionEvidence(
      "Restart reused the caller-owned profile and preserved S1 history",
      `Reopened workspace ${workspaceId}, session ${s1}; transcript=${JSON.stringify(persistedS1)}.`,
      true,
    );
    const historyShot = await screenshot(restartedApp);
    const historySeen = await validate(historyShot, [
      `After relaunch, session S1 still shows '${p1a}' and 'fresh-reply:${p1a}'`,
      `No reply containing 'fresh-reply:${p2a}' is visible in S1`,
      "No error dialog or crash message is visible",
    ]);
    expect(historySeen.ok, historySeen.why).toBe(true);

    const restartedModel = await selectModel(restartedApp, modelId);
    expect(restartedModel.id).toBe(modelId);
    expect(restartedModel.providerName).toContain("Engine restart freshness mock");
    await sendMessage(restartedApp, `freshness probe ${p1b}`);
    await waitForCompletionCall(completionBodies, 3, p1b);
    await waitFor(restartedApp, assistantHasText(`fresh-reply:${p1b}`), {
      timeoutMs: 120_000,
      label: `post-restart assistant reply for ${p1b}`,
    });

    await openSession(restartedApp, s2);
    await waitFor(restartedApp, assistantHasText(`fresh-reply:${p2a}`), {
      timeoutMs: 60_000,
      label: `persisted pre-restart reply for ${p2a}`,
    });
    await sendMessage(restartedApp, `freshness probe ${p2b}`);
    await waitForCompletionCall(completionBodies, 4, p2b);
    await waitFor(restartedApp, assistantHasText(`fresh-reply:${p2b}`), {
      timeoutMs: 120_000,
      label: `post-restart assistant reply for ${p2b}`,
    });

    expect(completionBodies, completionBodies.map(requestSnippet).join("\n")).toHaveLength(4);
    const p1bCall = completionBodies.find((body) => requestContains(body, p1b));
    const p2bCall = completionBodies.find((body) => requestContains(body, p2b));
    expect(p1bCall, `No request contained ${p1b}: ${completionBodies.map(requestSnippet).join("\n")}`).toBeDefined();
    expect(p2bCall, `No request contained ${p2b}: ${completionBodies.map(requestSnippet).join("\n")}`).toBeDefined();
    expect(requestContains(p1bCall, p1a), requestSnippet(p1bCall)).toBe(true);
    expect(requestContains(p1bCall, `fresh-reply:${p1a}`), requestSnippet(p1bCall)).toBe(true);
    expect(requestContains(p1bCall, p2a), requestSnippet(p1bCall)).toBe(false);
    expect(requestContains(p1bCall, p2b), requestSnippet(p1bCall)).toBe(false);
    expect(requestContains(p2bCall, p2a), requestSnippet(p2bCall)).toBe(true);
    expect(requestContains(p2bCall, `fresh-reply:${p2a}`), requestSnippet(p2bCall)).toBe(true);
    expect(requestContains(p2bCall, p1a), requestSnippet(p2bCall)).toBe(false);
    expect(requestContains(p2bCall, p1b), requestSnippet(p2bCall)).toBe(false);
    evidence.recordAssertionEvidence(
      "After restart, each fresh turn assembled only its own session history",
      `P1b request messages=${requestSnippet(p1bCall)}; P2b request messages=${requestSnippet(p2bCall)}; total calls=${completionBodies.length}.`,
      true,
    );

    await openSession(restartedApp, s1);
    const finalS1 = await readTranscript(restartedApp, s1);
    assertTranscript(finalS1, p1a, p1b, p2a, p2b);
    await openSession(restartedApp, s2);
    const finalS2 = await readTranscript(restartedApp, s2);
    assertTranscript(finalS2, p2a, p2b, p1a, p1b);
    evidence.recordAssertionEvidence(
      "Both UI transcripts contain exactly two fresh user/assistant turns with no cross-session replies",
      `S1 transcript=${JSON.stringify(finalS1)}; S2 transcript=${JSON.stringify(finalS2)}.`,
      true,
    );

    const finalShot = await screenshot(restartedApp);
    const finalSeen = await validate(finalShot, [
      `Session S2 shows exactly two user turns and two assistant replies, including 'fresh-reply:${p2a}' and 'fresh-reply:${p2b}'`,
      `No reply containing 'fresh-reply:${p1a}' or 'fresh-reply:${p1b}' is visible in S2`,
      "No error dialog or crash message is visible",
    ]);
    expect(finalSeen.ok, finalSeen.why).toBe(true);
  } finally {
    await restartedApp.stop();
  }
});
