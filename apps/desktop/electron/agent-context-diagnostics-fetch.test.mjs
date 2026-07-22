import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  AGENT_CONTEXT_DIAGNOSTICS_RESPONSE_MAX_BYTES,
  AgentContextDiagnosticsFetchError,
  fetchAgentContextDiagnosticsResponse,
} from "./agent-context-diagnostics-fetch.mjs";

/**
 * @param {import("node:http").RequestListener} handler
 * @returns {Promise<{ server: import("node:http").Server; url: string }>}
 */
function listenServer(handler) {
  return new Promise((resolve, reject) => {
    const server = createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to resolve test server address."));
        return;
      }
      resolve({ server, url: `http://127.0.0.1:${address.port}` });
    });
  });
}

/**
 * @param {import("node:http").Server} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("Electron diagnostics fetch keeps the absolute deadline through a stalled remote body", async () => {
  let bodyCanceled = false;
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
    },
    cancel() {
      bodyCanceled = true;
    },
  }), { status: 200 });
  const startedAtMs = Date.now();

  await assert.rejects(
    fetchAgentContextDiagnosticsResponse(
      async () => response,
      "https://remote.openwork.test/workspace/test/diagnostics/agent-context",
      { method: "POST", body: "{}" },
      startedAtMs + 40,
    ),
    (error) => {
      assert.ok(error instanceof AgentContextDiagnosticsFetchError);
      assert.equal(error.code, "agent_context_diagnostics_request_timed_out");
      return true;
    },
  );

  assert.ok(Date.now() - startedAtMs < 1_000);
  await Promise.resolve();
  assert.equal(bodyCanceled, true);
});

test("Electron diagnostics fetch rejects a chunked oversized remote response", async () => {
  const chunk = new Uint8Array((AGENT_CONTEXT_DIAGNOSTICS_RESPONSE_MAX_BYTES / 2) + 1);
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(chunk);
      controller.enqueue(chunk);
      controller.close();
    },
  }), { status: 200 });

  await assert.rejects(
    fetchAgentContextDiagnosticsResponse(
      async () => response,
      "https://remote.openwork.test/workspace/test/diagnostics/agent-context",
      { method: "POST", body: "{}" },
      Date.now() + 1_000,
    ),
    (error) => {
      assert.ok(error instanceof AgentContextDiagnosticsFetchError);
      assert.equal(error.code, "agent_context_diagnostics_response_too_large");
      return true;
    },
  );
});

test("Electron diagnostics fetch rejects an oversized declared response before buffering", async () => {
  const response = new Response("{}", {
    status: 200,
    headers: {
      "content-length": String(AGENT_CONTEXT_DIAGNOSTICS_RESPONSE_MAX_BYTES + 1),
    },
  });

  await assert.rejects(
    fetchAgentContextDiagnosticsResponse(
      async () => response,
      "https://remote.openwork.test/workspace/test/diagnostics/agent-context",
      { method: "POST", body: "{}" },
      Date.now() + 1_000,
    ),
    (error) => {
      assert.ok(error instanceof AgentContextDiagnosticsFetchError);
      assert.equal(error.code, "agent_context_diagnostics_response_too_large");
      return true;
    },
  );
});

test("Electron diagnostics fetch does not forward credentials across a remote redirect", async () => {
  const hostToken = "diagnostics-host-token-canary";
  const bearerToken = "diagnostics-bearer-token-canary";
  /** @type {string | null} */
  let redirectHostToken = null;
  /** @type {string | null} */
  let targetHostToken = null;
  /** @type {string | null} */
  let targetAuthorization = null;
  let targetRequests = 0;
  const target = await listenServer((request, response) => {
    targetRequests += 1;
    const receivedHostToken = request.headers["x-openwork-host-token"];
    const receivedAuthorization = request.headers.authorization;
    targetHostToken = typeof receivedHostToken === "string" ? receivedHostToken : null;
    targetAuthorization = typeof receivedAuthorization === "string" ? receivedAuthorization : null;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const redirector = await listenServer((request, response) => {
    const receivedHostToken = request.headers["x-openwork-host-token"];
    redirectHostToken = typeof receivedHostToken === "string" ? receivedHostToken : null;
    response.writeHead(307, { location: `${target.url}/capture` });
    response.end();
  });

  try {
    await assert.rejects(fetchAgentContextDiagnosticsResponse(
      globalThis.fetch,
      `${redirector.url}/diagnostics`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearerToken}`,
          "X-OpenWork-Host-Token": hostToken,
        },
        body: "{}",
      },
      Date.now() + 1_000,
    ));

    assert.equal(redirectHostToken, hostToken);
    assert.equal(targetRequests, 0);
    assert.equal(targetHostToken, null);
    assert.equal(targetAuthorization, null);
  } finally {
    await closeServer(redirector.server);
    await closeServer(target.server);
  }
});
