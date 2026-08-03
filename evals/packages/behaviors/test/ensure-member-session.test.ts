import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { ensureMemberSession, type DenSession } from "../src/den.ts";

function respondJson(response: import("node:http").ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

async function withStubServer(
  allowPublicSignup: boolean,
  run: (den: { apiUrl: string; webUrl: string }, requests: string[]) => Promise<void>,
): Promise<void> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://stub.test");
    requests.push(`${request.method} ${url.pathname}`);
    if (request.method === "POST" && url.pathname === "/api/auth/sign-in/email") {
      respondJson(response, 401, { error: "invalid_credentials" });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/auth/login-options") {
      respondJson(response, 200, {
        email: url.searchParams.get("email"),
        nextStep: allowPublicSignup ? "new_account" : "password",
        allowPublicSignup,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/invitations") {
      respondJson(response, 200, { inviteToken: "invite-token" });
      return;
    }
    respondJson(response, 409, { error: "stop_after_invitation" });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    await run({ apiUrl: `http://127.0.0.1:${address.port}`, webUrl: "http://localhost" }, requests);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

const credentials = { email: "member@example.com", password: "password123" };

function adminSession(den: { apiUrl: string; webUrl: string }): DenSession {
  return { ...den, token: "admin-token", email: "admin@example.com", password: "admin-password" };
}

test("ensureMemberSession explains how to enable member bootstrap when signup is disabled", async () => {
  await withStubServer(false, async (den, requests) => {
    await assert.rejects(
      ensureMemberSession(den, adminSession(den), credentials),
      /Member bootstrap needs public signup.*DEN_ORG_MODE=multi_org.*DEN_SINGLE_ORG_ALLOW_PUBLIC_SIGNUP=true.*member@example\.com/,
    );
    assert.deepEqual(requests, ["POST /api/auth/sign-in/email", "GET /v1/auth/login-options"]);
  });
});

test("ensureMemberSession proceeds to invitation when signup is allowed", async () => {
  await withStubServer(true, async (den, requests) => {
    await assert.rejects(
      ensureMemberSession(den, adminSession(den), credentials),
      /Member sign-up failed: HTTP 409/,
    );
    assert.deepEqual(requests, [
      "POST /api/auth/sign-in/email",
      "GET /v1/auth/login-options",
      "POST /v1/invitations",
      "POST /api/auth/sign-up/email",
    ]);
  });
});
