import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { Place, Seed } from "@openwork/env";
import { chrome } from "@openwork/hosts";
import {
  createExternalMcpDiagnosticFetch,
  ExternalMcpDiagnosticTracker,
} from "../../ee/apps/den-api/src/capability-sources/external-mcp-diagnostics.ts";
import { connectCallbackPage } from "../../ee/apps/den-api/src/capability-sources/oauth-callback-page.ts";
import { close, listen } from "./openwork-server-cli.ts";

/** Proof scope: real response classification → real generated callback HTML in
 * Chrome, not the production OAuth route. Only the provider response and HTTP
 * host are fixtures; no Den, database, credentials, or live Slack calls. */
export async function slackMcpDisabled(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack();
  try {
    // On the clean base this new helper does not exist. Keep the original
    // diagnostic message and omit the action there, so the same browser claim
    // fails on actual generic copy rather than on a missing-module import.
    // Existing helpers must import successfully; no import errors are swallowed.
    const guidanceUrl = new URL("../../ee/apps/den-api/src/capability-sources/slack-mcp-guidance.ts", import.meta.url);
    const guidance: typeof import("../../ee/apps/den-api/src/capability-sources/slack-mcp-guidance.ts") | undefined = existsSync(guidanceUrl) ? await import(guidanceUrl.href) : undefined;
    const endpoint = "https://mcp.slack.com/mcp";
    const cases = [
      { path: "/blocked", referenceId: "ref-slack-disabled-fixture", error_message: "App is not enabled for Slack MCP server access. Please enable it here: https://api.slack.com/apps/A0123456789/app-assistant" },
      { path: "/generic", referenceId: "ref-generic-fixture", error_message: "Unknown request" },
    ];
    const documents = new Map<string, string>();
    const diagnostics = [];
    for (const fixture of cases) {
      const tracker = new ExternalMcpDiagnosticTracker(fixture.referenceId);
      const diagnosticFetch = createExternalMcpDiagnosticFetch({
        endpoint,
        tracker,
        fetch: async () => new Response(JSON.stringify({ error_code: -32600, error_message: fixture.error_message }), {
          status: 400, headers: { "content-type": "application/json" },
        }),
      });
      await diagnosticFetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      });
      const diagnostic = tracker.error(new Error("Initialize rejected"), "MCP_INITIALIZE").diagnostic;
      diagnostics.push(diagnostic);
      documents.set(fixture.path, connectCallbackPage({
        ok: false,
        name: "Slack",
        message: diagnostic.message,
        referenceId: diagnostic.referenceId,
        providerSetupUrl: guidance?.slackMcpAccessGuidance(diagnostic)?.settingsUrl,
      }));
    }
    // Navigation fixture only; the callback documents above are served unchanged.
    const index = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connection response cases</title></head><body><h1>Connection response cases</h1><ul><li><a href="/blocked">Slack access disabled</a></li><li><a href="/generic">Unknown request</a></li></ul></body></html>`;
    const server = createServer((request, response) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(documents.get(path) ?? index);
    });
    const url = await listen(server);
    resources.defer(() => close(server));
    const web = resources.use(await chrome({ host: place.host(), name: "slack-mcp-disabled", startUrl: url, headless: true }));
    return {
      web, url, diagnostics,
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
