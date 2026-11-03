import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { serve } from "../src/serve-node.js";
import type { ServerConfig } from "../src/types.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("upload authority is freshly verified, stable across token rotation and never read from another account's disk cache", async () => {
  const directory = await mkdtemp(join(tmpdir(), "browser-upload-policy-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(directory, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(directory, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  let memberId = "member_fixture", enabled = true, unavailable = false;
  const rules = [{ action: "browser_upload", resource: "*", effect: "deny", source: "Everyone" }];
  const reply = () => unavailable ? new Response(null, { status: 403 }) : Response.json({
    agentPermissions: { rules }, browserUploadPermissions: { enabled, organizationId: "org_fixture", memberId },
  });
  let held: { started: ReturnType<typeof deferred<void>>; response: ReturnType<typeof deferred<Response>> } | undefined;
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    assert.equal(request.headers.get("X-OpenWork-Browser-Upload-Permissions"), "1");
    if (held) { const wait = held; held = undefined; wait.started.resolve(); return wait.response.promise; }
    return reply();
  } });
  const policy = managedDesktopPolicy(config);
  const session = { baseUrl: `http://127.0.0.1:${server.port}`, orgId: "org_fixture", token: "fixture-token" };
  try {
    assert.deepEqual(await policy.browserUploadPolicy(), { enabled: false, scope: null, rules: [] });
    await policy.setSession(session);
    const first = await policy.browserUploadPolicy();
    assert.deepEqual(first.scope, { baseUrl: session.baseUrl, organizationId: session.orgId, memberId });
    assert.deepEqual(first.rules, rules);
    await policy.setSession({ ...session, token: "rotated-token" });
    assert.deepEqual((await policy.browserUploadPolicy()).scope, first.scope, "tokens are not permission partitions");
    unavailable = true;
    await assert.rejects(policy.browserUploadPolicy(), /Den request failed/, "offline cannot fall back to stale upload Allow");
    unavailable = false;
    enabled = false;
    assert.deepEqual(await policy.browserUploadPolicy(), { enabled: false, scope: null, rules: [] });
    enabled = true;
    const pending = { started: deferred<void>(), response: deferred<Response>() };
    held = pending;
    const stale = policy.browserUploadPolicy();
    const rejected = assert.rejects(stale, { code: "policy_identity_changed" });
    await pending.started.promise;
    memberId = "member_other";
    await policy.setSession({ ...session, token: "other-member-token" });
    pending.response.resolve(Response.json({ browserUploadPermissions: { enabled: true, organizationId: "org_fixture", memberId: "member_fixture" } }));
    await rejected;
    assert.equal((await policy.browserUploadPolicy()).scope?.memberId, "member_other");
  } finally {
    await policy.clearSession();
    await server.stop();
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
