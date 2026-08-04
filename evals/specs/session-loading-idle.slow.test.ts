import { createServer } from "node:http";
import { expect, onTestFinished } from "vitest";
import { control, createAndSelectWorkspace, evalIn, waitFor, waitForText } from "@openwork/behaviors";
import { screenshot, validate } from "@openwork/fraimz";
import { desktop } from "@openwork/hosts";
import { needs, test } from "@openwork/testkit";

const providerId = "session-loading-idle-mock";
const modelId = "session-loading-idle-model";
const reply = "session loading idle proof";
const renamedTitle = "Session loading stays idle";
const appSpecsEnabled = process.env.OPENWORK_EVAL_APP_SPECS === "1";
const title = appSpecsEnabled
  ? "completed session loading stays idle after snapshot refetch and rename"
  : "session loading idle skipped — needs: set OPENWORK_EVAL_APP_SPECS=1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function newestSessionId(value: unknown): string {
  if (!Array.isArray(value) || value.length === 0 || !isRecord(value[0]) || typeof value[0].sessionId !== "string") {
    throw new Error(`session.list_sessions did not return a newest session: ${JSON.stringify(value)}`);
  }
  return value[0].sessionId;
}

function indicatorExpression(sessionId: string, present: boolean): string {
  return `(() => {
    const row = document.querySelector(${JSON.stringify(`[data-sidebar-session-id="${sessionId}"]`)});
    const indicator = row?.querySelector("[data-session-loading-indicator]");
    return ${present ? "Boolean(indicator)" : "!indicator"};
  })()`;
}

const stopDisabledExpression = `(() => {
  const stop = window.__openworkControl.listActions().find((action) => action.id === "composer.stop");
  return Boolean(stop?.disabled);
})()`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

test.skipIf(!appSpecsEnabled)(title, async ({ evidence }) => {
  needs({ optIn: ["OPENWORK_EVAL_APP_SPECS"] });

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
        const delayMs = body.includes("Reply with exactly") ? 8_000 : 0;
        setTimeout(() => {
          const chunks = [
            { id: "chatcmpl-session-loading-idle", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
            { id: "chatcmpl-session-loading-idle", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: reply }, finish_reason: null }] },
            { id: "chatcmpl-session-loading-idle", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
          ];
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
          response.write("data: [DONE]\n\n");
          response.end();
        }, delayMs);
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

  await using app = await desktop({ name: "session-loading-idle" });
  const workspace = await createAndSelectWorkspace(app, {
    path: `/tmp/openwork-session-loading-idle-${Date.now()}`,
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
          provider: {
            [${JSON.stringify(providerId)}]: {
              npm: "@ai-sdk/openai-compatible",
              name: "Session loading idle mock",
              options: { baseURL: ${JSON.stringify(baseUrl)}, apiKey: "sk-session-loading-idle" },
              models: {
                [${JSON.stringify(modelId)}]: { name: "Session loading idle model" },
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
  const parkingSessionId = newestSessionId(await control(app, "session.list_sessions"));
  await control(app, "session.create_task");
  const mainSessionId = newestSessionId(await control(app, "session.list_sessions"));
  expect(mainSessionId).not.toBe(parkingSessionId);

  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "composer.set_text" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "main session composer text action enabled",
  });
  await control(app, "composer.set_text", { text: `Reply with exactly: ${reply}` });
  await waitFor(app, `window.__openworkControl.listActions().some((action) => action.id === "composer.send" && !action.disabled)`, {
    timeoutMs: 30_000,
    label: "main session composer send action enabled",
  });
  await control(app, "composer.send");
  await waitFor(app, indicatorExpression(mainSessionId, true), {
    timeoutMs: 30_000,
    label: "main session sidebar activity indicator active",
  });
  evidence.fact(
    "The sidebar session row shows a loading indicator while the run is active",
    "[data-session-loading-indicator] appeared under the main session row after composer.send.",
    true,
  );
  const runningShot = await screenshot(app);
  await control(app, "session.open", { sessionId: parkingSessionId });
  await control(app, "session.open", { sessionId: mainSessionId });
  await waitFor(app, `(() => {
    if (!window.location.hash.includes(${JSON.stringify(mainSessionId)})) return false;
    const row = document.querySelector(${JSON.stringify(`[data-sidebar-session-id="${mainSessionId}"]`)});
    return Boolean(row?.querySelector("[data-session-loading-indicator]"));
  })()`, {
    timeoutMs: 10_000,
    label: "main session reopened while sidebar activity remains active",
  });
  await sleep(500);
  {
    const seen = await validate(runningShot, [
      `The user's message asking to reply with '${reply}' is visible in the conversation, with no completed assistant reply below it yet`,
      "No error dialog or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }

  await waitForText(app, reply, { timeoutMs: 120_000 });
  await waitFor(app, indicatorExpression(mainSessionId, false), {
    timeoutMs: 30_000,
    label: "completed main session sidebar activity indicator cleared",
  });
  await waitFor(app, stopDisabledExpression, {
    timeoutMs: 30_000,
    label: "completed main session stop action disabled",
  });

  await sleep(3_000);
  await control(app, "session.rename", { sessionId: mainSessionId, title: renamedTitle });

  for (let second = 1; second <= 8; second += 1) {
    await sleep(1_000);
    expect(
      await evalIn(app, indicatorExpression(mainSessionId, false)),
      `activity indicator returned ${second}s after rename`,
    ).toBe(true);
  }
  expect(await evalIn(app, stopDisabledExpression), "composer.stop became enabled after rename").toBe(true);
  evidence.fact(
    "The completed session's activity indicator stays idle after a mid-run snapshot refetch and a post-idle rename",
    "The sidebar indicator remained absent for eight consecutive one-second checks after the completed session was renamed, and composer.stop remained disabled.",
    true,
  );

  {
    const shot = await screenshot(app);
    const seen = await validate(shot, [
      "The session row for the renamed session shows no activity spinner",
      `The assistant reply '${reply}' is visible in the conversation`,
      "No error dialog or crash message is visible",
    ]);
    expect(seen.ok, seen.why).toBe(true);
  }
});
