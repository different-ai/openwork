import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import { deleteConnection, deleteConnectionsNamed, type DenSession } from "../src/den.ts";

function respondJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

test("deleteConnection refreshes a stale session once before retrying teardown", async () => {
  const requests: { path: string; authorization: string; body: string }[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = new URL(request.url ?? "/", "http://stub.test").pathname;
      const authorization = request.headers.authorization ?? "";
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ path, authorization, body });
      if (request.method === "DELETE" && path === "/v1/mcp-connections/connection-1" && authorization === "Bearer stale-token") {
        respondJson(response, 403, { error: "reauth", reason: "fresh_auth_required" });
        return;
      }
      if (request.method === "POST" && path === "/api/auth/sign-in/email") {
        respondJson(response, 200, { token: "fresh-token" });
        return;
      }
      if (request.method === "DELETE" && path === "/v1/mcp-connections/connection-1" && authorization === "Bearer fresh-token") {
        respondJson(response, 204, null);
        return;
      }
      respondJson(response, 500, { error: "unexpected_request" });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const session: DenSession = {
      apiUrl: `http://127.0.0.1:${address.port}`,
      webUrl: "http://localhost",
      token: "stale-token",
      email: "admin@example.com",
      password: "same-password",
    };

    await deleteConnection(session, "connection-1");

    assert.deepEqual(requests.map(({ path, authorization }) => ({ path, authorization })), [
      { path: "/v1/mcp-connections/connection-1", authorization: "Bearer stale-token" },
      { path: "/api/auth/sign-in/email", authorization: "" },
      { path: "/v1/mcp-connections/connection-1", authorization: "Bearer fresh-token" },
    ]);
    assert.deepEqual(JSON.parse(requests[1]?.body ?? ""), {
      email: "admin@example.com",
      password: "same-password",
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("deleteConnectionsNamed refreshes a stale list session once", async () => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://stub.test").pathname;
    const authorization = request.headers.authorization ?? "";
    requests.push(`${request.method} ${path} ${authorization}`.trim());
    if (request.method === "GET" && path === "/v1/mcp-connections" && authorization === "Bearer stale-token") {
      respondJson(response, 403, { error: "reauth", reason: "fresh_auth_required" });
      return;
    }
    if (request.method === "POST" && path === "/api/auth/sign-in/email") {
      respondJson(response, 200, { token: "fresh-token" });
      return;
    }
    if (request.method === "GET" && path === "/v1/mcp-connections" && authorization === "Bearer fresh-token") {
      respondJson(response, 200, {
        connections: [
          { id: "delete-me", name: "eval-cleanup-one" },
          { id: "keep-me", name: "other-connection" },
        ],
      });
      return;
    }
    if (request.method === "DELETE" && path === "/v1/mcp-connections/delete-me" && authorization === "Bearer fresh-token") {
      response.writeHead(204);
      response.end();
      return;
    }
    respondJson(response, 500, { error: "unexpected_request" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await deleteConnectionsNamed({
      apiUrl: `http://127.0.0.1:${address.port}`,
      webUrl: "http://localhost",
      token: "stale-token",
      email: "admin@example.com",
      password: "same-password",
    }, "eval-cleanup-");

    assert.deepEqual(requests, [
      "GET /v1/mcp-connections Bearer stale-token",
      "POST /api/auth/sign-in/email",
      "GET /v1/mcp-connections Bearer fresh-token",
      "DELETE /v1/mcp-connections/delete-me Bearer fresh-token",
    ]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});
