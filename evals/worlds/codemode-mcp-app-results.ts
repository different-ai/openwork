import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { Seed } from "@openwork/env";
import { readHeadlessRuntimeManifest, resolveHeadlessWorldRuntimePaths } from "@openwork/world";
import { configureProvider } from "./chat.ts";
import { isRecord, stringField } from "./library.ts";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";

const prompt = "Open a recipient review before preparing my draft. Do not send anything.";
const reply = "The recipient review is ready. Nothing has been sent.";
const resourceUri = "ui://recipient-review/form.html";

/** A protocol App, not static screenshot markup: the form appears ONLY after a
 * complete tool-result notification, including provider metadata, arrives. */
function reviewHtml(receipt: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>
    :root { color-scheme: light dark; font: 14px/1.5 system-ui; }
    body { margin: 0; padding: 24px; color: var(--color-text-primary, CanvasText); background: var(--color-background-primary, Canvas); }
    h1 { font-size: 22px; } label, input, button { display: block; margin-top: 12px; }
    input, button { font: inherit; padding: 8px 12px; } input { width: min(320px, 85%); }
  </style></head><body><p id="loading">Waiting for recipient review</p><main id="review" hidden>
    <h1 id="title"></h1><p id="message"></p><label for="email">Email recipient</label>
    <input id="email" type="email" autocomplete="off"><button id="review-button" type="button">Review recipient</button>
    <h2 id="status">Nothing has been sent.</h2>
  </main><script>
    const send = message => parent.postMessage({ jsonrpc: "2.0", ...message }, "*");
    addEventListener("message", event => {
      if (event.source !== parent || !event.data || event.data.jsonrpc !== "2.0") return;
      const message = event.data;
      if (message.id === 1 && message.result) send({ method: "ui/notifications/initialized" });
      if (message.method !== "ui/notifications/tool-result") return;
      const result = message.params;
      const state = result && result.structuredContent;
      if (!state || state.state !== "ask_email" || state.sent !== false
        || !result._meta || result._meta["proof/receipt"] !== ${JSON.stringify(receipt)}
        || !Array.isArray(result.content) || !result.content.some(part => part.text === "Recipient review requires an email address.")) return;
      document.getElementById("title").textContent = state.title;
      document.getElementById("message").textContent = state.message;
      document.getElementById("loading").hidden = true;
      document.getElementById("review").hidden = false;
      send({ method: "ui/notifications/size-changed", params: { height: 340 } });
    });
    document.getElementById("review-button").addEventListener("click", () => {
      document.getElementById("status").textContent = "Recipient review opened locally. Draft remains unsent.";
      document.getElementById("email").focus();
    });
    send({ id: 1, method: "ui/initialize", params: {
      appInfo: { name: "Recipient review", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26"
    } });
  </script></body></html>`;
}

/** Real appWeb + V2 + Den capability gateway. Only the external connector and
 * model transport are deterministic. No App launch or chat metadata is seeded. */
export async function codemodeMcpAppResults(seed: Seed) {
  const receipt = randomUUID();
  const { den, webPort } = await denForAppWeb(seed, {
    org: { name: "Recipient review workspace", admin: { name: "Workspace owner" } },
    env: { DEN_ALLOW_PRIVATE_MCP_URLS: "1" },
    mocks: { review: seed.mock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true, tools: [{
      name: "review_recipient", title: "Recipient review", description: "Open a recipient review before preparing a draft; never sends a message.",
      inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true, destructiveHint: false },
      _meta: { ui: { resourceUri, visibility: ["model", "app"] } },
      appHtml: reviewHtml(receipt),
      result: {
        content: [{ type: "text", text: "Recipient review requires an email address." }],
        structuredContent: { state: "ask_email", title: "Recipient required", message: "Choose a recipient before preparing the draft.", sent: false },
        _meta: { "proof/receipt": receipt },
      },
    }] }) },
  });
  const connection = await seed.orgConnection(den.admin, {
    name: "Recipient review", url: den.mocks.review.mcpUrl, authType: "none", credentialMode: "shared", access: { orgWide: true },
  });
  const orgResponse = await seed.api(den.admin, "/v1/org");
  const orgId = isRecord(orgResponse.body) ? stringField(orgResponse.body.organization, "id") : "";
  if (!orgId) throw new Error("Missing recipient review organization");
  const issued = await seed.api(den.admin, "/v1/mcp/token", {
    method: "POST", headers: { "x-openwork-org-id": orgId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }),
  });
  const token = stringField(issued.body, "token");
  const appHostToken = stringField(issued.body, "appHostToken");
  if (!issued.response.ok || !token || !appHostToken || token === appHostToken) throw new Error("Missing distinct recipient review model and App-host tokens");
  const call = { name: `mcp:${connection.id}:review_recipient`, body: {} };
  // Deliberately discard the script's return value: the UI must get the inner
  // MCP envelope from the collector, not rediscover it in the outer output.
  const code = `await tools["openwork-cloud"].execute_capability(${JSON.stringify(call)}); return "Recipient review opened";`;
  const { app, workspace } = await signedInAppWeb(seed, {
    den, webPort, engine: "v2", name: "codemode-mcp-app-results", workspacePath: seed.tmpPath("codemode-mcp-app-results"),
    env: process.env.OPENWORK_OPENCODE2_BIN ? { OPENWORK_OPENCODE2_BIN: process.env.OPENWORK_OPENCODE2_BIN } : {},
    mocks: { agent: seed.mock({ isolatedProcessEnv: true, allowUnauthenticatedMcp: true, tools: [], agentWorkloads: [{
      promptMarker: prompt, latestUserTurn: true, finalReply: reply, steps: [{ tool: "execute", arguments: { code } }],
    }] }) },
  });
  const model = app.mocks.agent;
  if (!model) throw new Error("Missing deterministic recipient review model");
  const providerId = "recipient-review-proof";
  const modelId = "review";
  await configureProvider(seed, app, workspace.workspaceId, providerId, modelId, {
    provider: { [providerId]: { npm: "@ai-sdk/openai-compatible", name: "Recipient review model",
      options: { baseURL: `${model.url}/v1`, apiKey: "fixture-only" }, models: { [modelId]: { name: "Recipient review model" } },
    } },
  }, "v2");
  const paths = resolveHeadlessWorldRuntimePaths(fileURLToPath(new URL("../../", import.meta.url)), app.handle.name);
  const manifest = await readHeadlessRuntimeManifest(paths.runtimeManifestPath);
  if (!manifest) throw new Error("Missing owned app runtime manifest");
  const ownerResponse = await fetch(`${app.openworkUrl}/tokens`, {
    method: "POST", headers: { "X-OpenWork-Host-Token": manifest.hostToken, "Content-Type": "application/json" },
    body: JSON.stringify({ scope: "owner", label: "recipient-review-fixture" }),
  });
  const owner: unknown = await ownerResponse.json();
  const ownerToken = stringField(owner, "token");
  if (ownerResponse.status !== 201 || !ownerToken) throw new Error("Missing fixture owner token");
  const reconciled = await fetch(`${app.openworkUrl}/workspace/${workspace.workspaceId}/mcp/openwork-cloud/reconcile`, {
    method: "POST", headers: { Authorization: `Bearer ${ownerToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ config: { type: "remote", url: `${den.ref.apiUrl}/mcp/agent`, enabled: true, oauth: false, headers: { Authorization: `Bearer ${token}` } }, appHostAuthorization: `Bearer ${appHostToken}`, trigger: "recipient-review-fixture" }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!reconciled.ok) throw new Error(`Recipient review reconciliation failed: HTTP ${reconciled.status} ${(await reconciled.text()).slice(0, 500)}`);
  const session = await seed.session(app, { title: "Recipient review conversation" });
  return { app, workspace, session, model, connector: den.mocks.review, prompt, reply, resourceUri, receipt, code };
}
