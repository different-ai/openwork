import { createServer } from "node:http";
import { expect, onTestFinished } from "vitest";
import { control, createAndSelectWorkspace, evalIn, waitFor, waitForText } from "@openwork/behaviors";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const providerId = "session-title-failure-mock";
const modelId = "session-title-main-model";
const inaccessibleTitleModelId = "session-title-inaccessible-model";
const reply = "the conversation completed safely";
const warningTitle = "Automatic task title did not complete";
const warningBody = "Your conversation is safe.";
const e2eTestsEnabled = process.env.OPENWORK_EVAL_E2E_TESTS === "1";
const title = e2eTestsEnabled
  ? "a failed background title model stays non-fatal and produces a persistent warning"
  : "session title failure warning skipped — needs: set OPENWORK_EVAL_E2E_TESTS=1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function newestSession(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || value.length === 0 || !isRecord(value[0])) {
    throw new Error(`session.list_sessions did not return a newest session: ${JSON.stringify(value)}`);
  }
  return value[0];
}

test.skipIf(!e2eTestsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_E2E_TESTS"] });

  const mock = createServer((request, response) => {
    const url = request.url ?? "";
    if (request.method === "GET" && url.startsWith("/v1/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: modelId, object: "model" }] }));
      return;
    }

    if (request.method === "POST" && (url === "/v1/chat/completions" || url === "/chat/completions")) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        if (body.includes(`"model":"${inaccessibleTitleModelId}"`)) {
          response.writeHead(403, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "model is not accessible to this user" } }));
          return;
        }
        const chunks = [
          { id: "chatcmpl-session-title-failure", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
          { id: "chatcmpl-session-title-failure", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] },
          { id: "chatcmpl-session-title-failure", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
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

  const electronNodeDir = process.env.OPENWORK_EVAL_ELECTRON_NODEDIR?.trim();
  await using app = await desktop({
    name: "session-title-failure-warning",
    env: electronNodeDir ? { npm_config_nodedir: electronNodeDir } : undefined,
  });
  const workspace = await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-session-title-failure-${Date.now()}`,
  });

  const configured = await evalIn(app, `(async () => {
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
    const workspaceId = ${JSON.stringify(workspace.workspaceId)};
    const patched = await request("/workspace/" + encodeURIComponent(workspaceId) + "/config", {
      method: "PATCH",
      body: JSON.stringify({
        opencode: {
          small_model: ${JSON.stringify(`${providerId}/${inaccessibleTitleModelId}`)},
          provider: {
            [${JSON.stringify(providerId)}]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Session title failure mock",
              options: { baseURL: ${JSON.stringify(baseUrl)}, apiKey: "sk-session-title-failure" },
              models: {
                [${JSON.stringify(modelId)}]: { name: "Session title main model" },
              },
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

  await control(app, "session.create_task");
  const created = newestSession(await control(app, "session.list_sessions"));
  const sessionId = typeof created.sessionId === "string" ? created.sessionId : "";
  expect(sessionId).not.toBe("");

  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "composer.set_text" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "session composer text action enabled",
  });
  await control(app, "composer.set_text", { text: `Reply with exactly: ${reply}` });
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "composer.send" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "session composer send action enabled",
  });
  await control(app, "composer.send");
  await waitForText(app, reply, { timeoutMs: 60_000 });

  await waitFor(app, `document.body.innerText.includes(${JSON.stringify(warningTitle)})`, {
    timeoutMs: 50_000,
    label: "non-fatal automatic title warning",
  });
  expect(await evalIn(app, `document.body.innerText.includes(${JSON.stringify(warningBody)})`)).toBe(true);
  evidence.recordAssertionEvidence(
    "A failed background title model does not discard or fail the completed conversation",
    `The assistant reply '${reply}' remained visible when the title warning appeared for session ${sessionId}.`,
    true,
  );

  await evalIn(app, `(() => {
    const sidebar = document.querySelector('[data-sidebar="sidebar"]');
    const bell = [...(sidebar?.querySelectorAll("button") ?? [])]
      .find((button) => (button.getAttribute("aria-label") ?? "").startsWith("Notifications"));
    bell?.click();
  })()`);
  await waitFor(app, `document.body.innerText.includes(${JSON.stringify(warningTitle)})
    && document.body.innerText.includes(${JSON.stringify(warningBody)})`, {
    timeoutMs: 30_000,
    label: "persistent automatic title warning in notification center",
  });

  const after = newestSession(await control(app, "session.list_sessions"));
  expect(typeof after.title === "string" && after.title.startsWith("New session - ")).toBe(true);
  evidence.recordAssertionEvidence(
    "The unresolved generated placeholder is surfaced as one persistent, actionable warning",
    `The notification center explains that the conversation is safe and can be renamed while session ${sessionId} still has its generated placeholder.`,
    true,
  );
});
