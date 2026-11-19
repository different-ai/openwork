import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import type { Seed } from "@openwork/env";
import { close, listen, sendJson } from "./openwork-server-cli.ts";

/** Signed-out personal workspace on the v2 engine. The loopback deployment
 * answers only the features and session reads the app makes while signed out,
 * so the provider list is the engine's own catalog with no organization. */
export async function retiredOpencodeZen(seed: Seed) {
  const deployment = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    response.setHeader("access-control-allow-origin", request.headers.origin ?? "*");
    response.setHeader("access-control-allow-credentials", "true");
    response.setHeader("access-control-allow-headers", "authorization,content-type");
    response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
    if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
    if (path === "/v1/features") return sendJson(response, 200, { features: {} });
    if (path === "/api/auth/get-session") return sendJson(response, 200, null);
    sendJson(response, 404, { error: { message: "Unexpected deployment route" } });
  });
  const origin = await listen(deployment);
  try {
    const folder = seed.tmpPath("retired-opencode-zen");
    await mkdir(folder, { recursive: true });
    const workspacePath = await realpath(folder);
    const app = await seed.appWeb({
      den: { apiUrl: origin, webUrl: origin }, name: "retired-opencode-zen", workspacePath, engine: "v2", headless: true,
      env: { OPENWORK_TOKEN: randomUUID(), OPENWORK_HOST_TOKEN: randomUUID(), OPENWORK_DISABLE_FREE_INFERENCE: "1" },
    });
    const workspace = await seed.workspace(app, workspacePath);
    return {
      app, workspace,
      settingsUrl: `${app.webUrl}/workspace/${encodeURIComponent(workspace.workspaceId)}/settings/ai`,
      async [Symbol.asyncDispose]() { await close(deployment); },
    };
  } catch (error) {
    await close(deployment);
    throw error;
  }
}
