import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";
import { provisionOwnedWorkspace, configureOwnedProviders } from "../src/app-web-workspace.ts";

test("isolated workspace provisioning uses its host credential, not the browser client token", async (t) => {
  const hostToken = randomUUID();
  const seen: string[] = [];
  const canonicalPath = join(await realpath("/tmp"), "isolated-second-workspace");
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/workspaces/local");
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, undefined);
    if (request.headers["x-openwork-host-token"] !== hostToken) {
      response.writeHead(401).end("unauthorized");
      return;
    }
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed: unknown = JSON.parse(body);
    assert.deepEqual(parsed, { folderPath: canonicalPath });
    seen.push(body);
    response.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ activeId: "ws_second" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const openworkUrl = `http://127.0.0.1:${address.port}`;
  await assert.rejects(provisionOwnedWorkspace({ openworkUrl, hostToken: randomUUID() }, "/tmp/isolated-second-workspace"), /HTTP 401/);
  assert.deepEqual(await provisionOwnedWorkspace({ openworkUrl, hostToken }, "/tmp/isolated-second-workspace"), { workspaceId: "ws_second" });
  assert.equal(seen.length, 1);
});

test("workspace provisioning refuses credential forwarding on redirects and rejects missing identities", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    if (requests === 1) response.writeHead(302, { location: "/redirect-target" }).end();
    else response.writeHead(200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const owner = { openworkUrl: `http://127.0.0.1:${address.port}`, hostToken: randomUUID() };
  await assert.rejects(provisionOwnedWorkspace(owner, "/tmp/fixture"));
  assert.equal(requests, 1, "must not follow the redirected owner-authenticated request");
  await assert.rejects(provisionOwnedWorkspace(owner, "/tmp/fixture"), /no workspace identity/);
});

test("workspace provisioning rejects non-owned endpoint shapes before making a request", async () => {
  for (const openworkUrl of ["https://example.invalid", "http://user:password@localhost:1234", "http://localhost"]) {
    await assert.rejects(provisionOwnedWorkspace({ openworkUrl, hostToken: "fixture" }, "/tmp/fixture"), /owned loopback/);
  }
});

test("provider fixture setup uses the authenticated engine-global API and requires acknowledgement", async (t) => {
  const hostToken = randomUUID();
  const provider = { fixture: { models: { model: { name: "Fixture model" } } } };
  let calls = 0;
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/runtime-config/providers");
    assert.equal(request.method, "PATCH");
    assert.equal(request.headers["x-openwork-host-token"], hostToken);
    assert.equal(request.headers.authorization, undefined);
    let body = "";
    for await (const chunk of request) body += chunk;
    assert.deepEqual(JSON.parse(body), { provider });
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: ++calls === 1 }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const owner = { openworkUrl: `http://127.0.0.1:${address.port}`, hostToken };
  await configureOwnedProviders(owner, provider);
  await assert.rejects(configureOwnedProviders(owner, provider), /not acknowledged/);
});
