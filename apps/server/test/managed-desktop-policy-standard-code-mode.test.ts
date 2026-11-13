import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { serve } from "../src/serve-node.js";
import type { ServerConfig } from "../src/types.js";

test("remote computers still require the signed-in organization's rollout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-standard-code-mode-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(dir, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  const reads: Array<{ path: string; token: string | null }> = [];
  let features: Record<string, unknown> | null = { remoteComputers: true };
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/org") reads.push({ path, token: request.headers.get("authorization") });
    if (path !== "/v1/org") return Response.json({});
    return features ? Response.json({ features }) : new Response(null, { status: 500 });
  } });
  const policy = managedDesktopPolicy(config);
  const session = { baseUrl: `http://127.0.0.1:${server.port}`, token: "first-secret", orgId: "org_test" };
  try {
    assert.equal(await policy.remoteComputersEnabled(), false, "signed out cannot use remote computers");
    assert.equal(reads.length, 0);

    await policy.setSession(session);
    assert.equal(await policy.remoteComputersEnabled(), true);
    features = { remoteComputers: false };
    assert.equal(await policy.remoteComputersEnabled(), false, "remote access is checked again");
    assert.equal(reads.length, 2);

    // Another sign-in never reuses the previous one's answer.
    await policy.setSession({ ...session, token: "second-secret" });
    assert.equal(await policy.remoteComputersEnabled(), false);
    assert.equal(reads.at(-1)?.token, "Bearer second-secret");

    features = { computerUse: true };
    await policy.setSession({ ...session, token: "third-secret" });
    assert.equal(await policy.remoteComputersEnabled(), false, "a missing key is off");

    features = null;
    await policy.setSession({ ...session, token: "fourth-secret" });
    assert.equal(await policy.remoteComputersEnabled(), false, "an unreachable Den is off");
  } finally {
    await policy.clearSession();
    await server.stop();
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
