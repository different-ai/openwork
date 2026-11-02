import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { browserScript } from "@openwork/cdp";
import type { Seed } from "@openwork/env";
import { close, isRecord, listen, readBody, sendJson, sendStream } from "./openwork-server-cli.ts";

/** Signed-out personal workspace, native v2 engine and loopback-only inference.
 * The fake deployment serves the registry switch over the normal features API;
 * no organization, credentials or renderer state is needed to enable it. */
export async function providerCredentialStatus(seed: Seed) {
  const rejectedKey = "synthetic-provider-rejected-key";
  const replacementKey = "synthetic-provider-replacement-key";
  const answer = "Your replacement key works. This answer came from the local provider.";
  const providerId = "fault-lab";
  const modelId = "http-401";
  const requests: { path: string; model: unknown; status: number; credential: "original" | "replacement" | "unexpected" }[] = [];
  const upstream = createServer(async (request, response) => {
    try {
      const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      response.setHeader("access-control-allow-origin", request.headers.origin ?? "*");
      response.setHeader("access-control-allow-credentials", "true");
      response.setHeader("access-control-allow-headers", "authorization,content-type");
      response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
      if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
      if (path === "/v1/features") return sendJson(response, 200, { features: {} });
      if (path === "/api/auth/get-session") return sendJson(response, 200, null);
      if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
        sendJson(response, 404, { error: { message: "Unexpected local provider route" } });
        return;
      }
      const raw = await readBody(request);
      const body: unknown = raw ? JSON.parse(raw) : {};
      const credential = request.headers.authorization === `Bearer ${rejectedKey}` ? "original"
        : request.headers.authorization === `Bearer ${replacementKey}` ? "replacement" : "unexpected";
      const status = credential === "replacement" ? 200 : 401;
      requests.push({ path, model: isRecord(body) ? body.model : null, status, credential });
      if (status === 401) {
        // OpenRouter's real-world 401 shape, returned over native HTTP rather
        // than injected into a renderer or manufactured engine event.
        sendJson(response, 401, { error: { message: "User not found.", code: 401 } });
        return;
      }
      sendStream(response, [
        { id: "chatcmpl-credential-proof", object: "chat.completion.chunk", created: 1, model: modelId,
          choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] },
        { id: "chatcmpl-credential-proof", object: "chat.completion.chunk", created: 1, model: modelId,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } },
      ]);
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: { message: "Local provider fixture failed" } });
      else response.destroy();
    }
  });
  const origin = await listen(upstream);
  try {
    const folder = seed.tmpPath("provider-credential-status");
    await mkdir(folder, { recursive: true });
    const workspacePath = await realpath(folder);
    const token = randomUUID();
    const hostToken = randomUUID();
    const app = await seed.appWeb({
      den: { apiUrl: origin, webUrl: origin }, name: "provider-credential-status", workspacePath, engine: "v2", headless: true,
      env: { OPENWORK_TOKEN: token, OPENWORK_HOST_TOKEN: hostToken, OPENWORK_DISABLE_FREE_INFERENCE: "1" },
    });
    const workspace = await seed.workspace(app, workspacePath);
    // Seed the owned server through its public APIs, just as the native shell
    // hands off sign-in and the runtime provider editor saves configuration.
    // Reading the port here is transport discovery, not renderer state setup.
    async function request(path: string, method: string, body: unknown) {
      const result = await seed.evalIn(app, browserScript(async (path, method, body, token, hostToken) => {
        const port = localStorage.getItem("openwork.server.port");
        if (!port) throw new Error("Missing app-owned server port");
        const response = await fetch(`http://127.0.0.1:${port}${path}`, {
          method, headers: { Authorization: `Bearer ${token}`, "x-openwork-host-token": hostToken, "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: response.status, text: await response.text() };
      }, [path, method, body, token, hostToken]), { awaitPromise: true, timeoutMs: 120_000 });
      if (result.status >= 300) throw new Error(`Provider world ${method} ${path}: HTTP ${result.status} ${result.text.slice(0, 300)}`);
    }
    await request("/runtime-config/providers", "PATCH", { provider: {
      [providerId]: { name: "Fault Lab", npm: "@ai-sdk/openai-compatible", env: ["FAULT_LAB_API_KEY"],
        options: { baseURL: `${origin}/v1` },
        models: { [modelId]: { name: "Credential proof model", tool_call: true, limit: { context: 32000, output: 1024 } } },
      },
    } });
    return {
      app, workspace, providerId, modelId, rejectedKey, replacementKey, answer,
      settingsUrl: `${app.webUrl}/workspace/${encodeURIComponent(workspace.workspaceId)}/settings/ai`,
      composerUrl: `${app.webUrl}/workspace/${encodeURIComponent(workspace.workspaceId)}/session`,
      // Read-only upstream witnesses; never expose raw Authorization values.
      requests: () => requests.map(request => ({ ...request })),
      async nativeFailure() {
        const sessionId = await seed.evalIn(app, () => location.pathname.split("/").at(-1) ?? "");
        const response = await fetch(`${app.openworkUrl}/workspace/${encodeURIComponent(workspace.workspaceId)}/opencode2/api/session/${encodeURIComponent(sessionId)}/message`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
        });
        const payload: unknown = await response.json();
        const messages = isRecord(payload) && Array.isArray(payload.data) ? payload.data : [];
        return messages.flatMap((message) => {
          if (!isRecord(message) || !isRecord(message.error)) return [];
          return [{ type: typeof message.error.type === "string" ? message.error.type : "unknown", status: typeof message.error.status === "number" ? message.error.status : null }];
        });
      },
      async [Symbol.asyncDispose]() { await close(upstream); },
    };
  } catch (error) {
    await close(upstream);
    throw error;
  }
}
