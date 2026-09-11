import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, get, type IncomingMessage, type ServerResponse } from "node:http";
import test from "node:test";
import { close, listen, readBody, sendJson, sendMockError } from "../worlds/openwork-server-cli.ts";

function getResponse(url: string): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    get(url, { agent: false, signal: AbortSignal.timeout(5_000) }, resolve).once("error", reject);
  });
}

const sensitiveError = new Error("sensitive mock request message");
sensitiveError.stack = "Error: sensitive mock request message\n    at sensitiveMockFrame (/internal/sensitive-provider.ts:42:9)";

for (const { name, error } of [
  { name: "an Error with a sensitive message and stack", error: sensitiveError },
  { name: "a sensitive thrown string", error: "sensitive mock thrown string" },
]) {
  test(`sendMockError keeps ${name} server-side`, { timeout: 10_000 }, async t => {
    const logger = t.mock.method(console, "error", () => {});
    const server = createServer((_request, response) => {
      try {
        throw error;
      } catch (caught) {
        sendMockError(response, caught);
      }
    });
    t.after(() => close(server));

    const response = await getResponse(await listen(server));
    const body = await readBody(response);

    assert.equal(response.statusCode, 500);
    assert.equal(response.headers["content-type"], "application/json");
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(body, JSON.stringify({ error: "mock_request_failed" }));
    assert.doesNotMatch(JSON.stringify({ headers: response.rawHeaders, body }), /sensitive/);
    assert.equal(logger.mock.callCount(), 1);
    assert.equal(logger.mock.calls[0]?.arguments[0], "[mock] Request failed");
    assert.equal(logger.mock.calls[0]?.arguments[1], error);
    assert.equal(logger.mock.calls[0]?.arguments.length, 2);
  });
}

test("sendMockError closes an already-started response without a second header", { timeout: 10_000 }, async t => {
  const logger = t.mock.method(console, "error", () => {});
  const started = Promise.withResolvers<ServerResponse>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.write("already started");
    started.resolve(response);
  });
  t.after(() => close(server));

  const response = await getResponse(await listen(server));
  const serverResponse = await started.promise;
  const writeHead = t.mock.method(serverResponse, "writeHead");
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk: string) => { body += chunk; });
  const closed = new Promise<unknown>(resolve => {
    let failure: unknown;
    response.on("error", error => { failure = error; });
    response.once("close", () => resolve(failure));
  });
  await once(response, "data");

  sendMockError(serverResponse, sensitiveError);
  const destroyedImmediately = serverResponse.destroyed;
  const failure = await closed;

  assert.equal(destroyedImmediately, true);
  assert.equal(writeHead.mock.callCount(), 0);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/plain");
  assert.equal(response.complete, false);
  assert.equal(response.destroyed, true);
  assert.ok(failure instanceof Error && "code" in failure);
  assert.equal(failure.code, "ECONNRESET");
  assert.equal(body, "already started");
  assert.doesNotMatch(JSON.stringify({ headers: response.rawHeaders, body }), /sensitive|mock_request_failed/);
  assert.equal(logger.mock.callCount(), 1);
  assert.equal(logger.mock.calls[0]?.arguments[0], "[mock] Request failed");
  assert.equal(logger.mock.calls[0]?.arguments[1], sensitiveError);
  assert.equal(logger.mock.calls[0]?.arguments.length, 2);
});

test("sendJson preserves the supplied status and body without logging", { timeout: 10_000 }, async t => {
  const logger = t.mock.method(console, "error", () => {});
  const payload = { ok: true, data: [{ id: "mock" }], error: "intentional fixture payload" };
  const server = createServer((_request, response) => {
    sendJson(response, 201, payload);
  });
  t.after(() => close(server));

  const response = await getResponse(await listen(server));
  const body = await readBody(response);

  assert.equal(response.statusCode, 201);
  assert.equal(response.headers["content-type"], "application/json");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(body, JSON.stringify(payload));
  assert.equal(logger.mock.callCount(), 0);
});
