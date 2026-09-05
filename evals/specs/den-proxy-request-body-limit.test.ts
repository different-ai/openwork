import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { expect } from "vitest";
import { eventually, localMysqlIsRunning, localRedisIsRunning, needs, server, SkipError, test } from "@openwork/testkit";

const maxBytes = 32 * 1024 * 1024;

function postBody(url: URL, requestId: string, declared: boolean): Promise<{ response: Response; senderEnded: boolean }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        ...(declared ? { "content-length": String(maxBytes + 1) } : { "transfer-encoding": "chunked" }),
      },
      signal: AbortSignal.timeout(60_000),
    }, (response) => {
      const senderEnded = request.writableEnded;
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        resolve({ response: new Response(Buffer.concat(chunks), { status: response.statusCode }), senderEnded });
        request.destroy();
      });
    });
    request.on("error", reject);
    if (declared) {
      // Reject the declaration without waiting for its advertised payload.
      request.flushHeaders();
    } else {
      const chunk = Buffer.alloc(64 * 1024, "x");
      let written = 0;
      const writeNext = () => {
        if (request.destroyed || written > maxBytes) return;
        const size = Math.min(chunk.length, maxBytes + 1 - written);
        written += size;
        if (request.write(chunk.subarray(0, size))) setImmediate(writeNext);
        else request.once("drain", writeNext);
      };
      writeNext();
      // Deliberately never end the sender: buffering until EOF must time out,
      // while a streaming limit returns 413 as soon as the limit is crossed.
    }
  });
}

test("the auth proxy rejects oversized bodies before Den while ordinary sign-in still works", { timeout: 300_000 }, async ({ evidence, place }) => {
  needs({ commands: ["bun"] });
  if (place.kind === "local" && !await localMysqlIsRunning()) {
    throw new SkipError("local MySQL on 127.0.0.1:3306");
  }
  if (place.kind === "local" && !await localRedisIsRunning()) {
    throw new SkipError("local Redis on 127.0.0.1:6379");
  }
  await using den = await server({ place, web: true, org: { name: "Proxy body limit" } });
  const nonce = `${Date.now().toString(36)}-${process.pid}`;
  const declaredId = `proxy-declared-${nonce}`;
  const chunkedId = `proxy-chunked-${nonce}`;
  const acceptedId = `proxy-accepted-${nonce}`;
  const url = new URL("/api/auth/sign-in/email", den.ref.webUrl);

  const { response: declared, senderEnded: declaredEnded } = await postBody(url, declaredId, true);
  expect(declaredEnded).toBe(false);
  expect(declared.status).toBe(413);
  expect(await declared.json()).toMatchObject({
    error: "request_too_large", requestId: declaredId, maxBytes, declaredBytes: maxBytes + 1,
  });

  const { response: chunked, senderEnded: chunkedEnded } = await postBody(url, chunkedId, false);
  expect(chunkedEnded).toBe(false);
  expect(chunked.status).toBe(413);
  expect(await chunked.json()).toMatchObject({
    error: "request_too_large", requestId: chunkedId, maxBytes, observedBytes: maxBytes + 1,
  });

  const accepted = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-request-id": acceptedId, origin: den.ref.webUrl },
    body: JSON.stringify({ email: den.admin.email, password: den.admin.password }),
    signal: AbortSignal.timeout(30_000),
  });
  expect(accepted.status).toBe(200);
  expect(accepted.headers.get("set-cookie")).toContain("session_token");

  // Observe the accepted control before using absence to prove non-delivery.
  await eventually(async () => (await den.apiLog()).includes(acceptedId), { within: 10_000 });
  const log = await den.apiLog();
  expect(log).toContain(acceptedId);
  expect(log).not.toContain(declaredId);
  expect(log).not.toContain(chunkedId);
  evidence.recordAssertionEvidence(
    "Declared and chunked oversized bodies stop at the web boundary without contacting Den",
    "Both real auth-proxy requests returned structured 413 responses; the API log contained the accepted control request and neither rejection id.",
    !log.includes(declaredId) && !log.includes(chunkedId) && log.includes(acceptedId),
  );
  evidence.recordAssertionEvidence(
    "An ordinary sign-in still reaches Den and returns its session cookie",
    `HTTP ${accepted.status}; session cookie present: ${Boolean(accepted.headers.get("set-cookie")?.includes("session_token"))}`,
    accepted.status === 200 && Boolean(accepted.headers.get("set-cookie")?.includes("session_token")),
  );
});
