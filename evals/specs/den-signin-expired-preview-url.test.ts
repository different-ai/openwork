import { createServer } from "node:http";
import type { Server } from "node:http";
import { expect, test } from "vitest";
import { expiredPreviewUrlHint, signIn } from "@openwork/behaviors";

/**
 * A Daytona preview hostname carries a signed, expiring token, so a reused URL
 * eventually fails at the proxy with its own 401 — before Den ever sees the
 * request. The failure text was indistinguishable from rejected credentials
 * ("Sign-in failed for alex@acme.test: HTTP 401 ... Invalid or expired token"),
 * which reads as a Den auth problem and sends the reader to the wrong layer.
 * These claims pin the diagnosis to the layer that actually refused.
 */

const proxyBody = {
  statusCode: 401,
  message: "unauthorized: authentication failed: Invalid or expired token",
  code: "UNAUTHORIZED",
  path: "/api/auth/sign-in/email",
  method: "POST",
};

async function startStub(status: number, body: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stub server did not bind a port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

test("an expired Daytona preview URL is named as the cause, not the credentials", () => {
  const hint = expiredPreviewUrlHint("https://8788-q1syj5cojnvni1pn.daytonaproxy01.net", 401, proxyBody);
  expect(hint).toContain("preview URL looks expired");
  expect(hint).toContain("OPENWORK_EVAL_DEN_API_URL");
});

test("a real Den credential rejection keeps its own diagnosis", () => {
  // Same status from Den itself: no proxy host, so no preview-URL hint.
  const denRejection = expiredPreviewUrlHint("https://den.example.com", 401, { code: "INVALID_CREDENTIALS" });
  expect(denRejection).toBe("");
  // A proxy host that answers something other than its expiry shape is Den's.
  const otherProxyError = expiredPreviewUrlHint("https://8788-abc.daytonaproxy01.net", 401, { code: "INVALID_CREDENTIALS" });
  expect(otherProxyError).toBe("");
  // A non-401 never earns the hint.
  const notUnauthorized = expiredPreviewUrlHint("https://8788-abc.daytonaproxy01.net", 500, proxyBody);
  expect(notUnauthorized).toBe("");
});

test("signIn surfaces the failing status and body regardless of layer", async () => {
  const stub = await startStub(401, proxyBody);
  try {
    const failure = await signIn(
      { apiUrl: stub.url, webUrl: stub.url },
      { email: "alex@acme.test", password: "OpenWorkDemo123!" },
    ).then(() => null, (error: unknown) => (error instanceof Error ? error.message : String(error)));
    expect(failure).toContain("Sign-in failed for alex@acme.test");
    expect(failure).toContain("HTTP 401");
    // A loopback stub is not a preview host, so the hint must stay off.
    expect(failure).not.toContain("preview URL looks expired");
  } finally {
    await stub.close();
  }
});
