import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { serve } from "../src/serve-node.js";
import type { ServerConfig } from "../src/types.js";

test("cloud computer programs follow the signed-in organization's standardCodeMode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-standard-code-mode-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(dir, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  const reads: Array<{ path: string; token: string | null }> = [];
  let features: Record<string, unknown> | null = { standardCodeMode: true };
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/org") reads.push({ path, token: request.headers.get("authorization") });
    if (path !== "/v1/org") return Response.json({});
    return features ? Response.json({ features }) : new Response(null, { status: 500 });
  } });
  const policy = managedDesktopPolicy(config);
  const session = { baseUrl: `http://127.0.0.1:${server.port}`, token: "first-secret", orgId: "org_test" };
  try {
    assert.equal(await policy.standardCodeModeEnabled(), false, "signed out runs OpenWork's Code Mode without asking Den");
    assert.equal(reads.length, 0);

    await policy.setSession(session);
    assert.equal(await policy.standardCodeModeEnabled(), true);
    features = { standardCodeMode: false };
    assert.equal(await policy.standardCodeModeEnabled(), true, "a recent answer is reused");
    assert.equal(reads.length, 1);

    // Another sign-in never reuses the previous one's answer.
    await policy.setSession({ ...session, token: "second-secret" });
    assert.equal(await policy.standardCodeModeEnabled(), false);
    assert.equal(reads.at(-1)?.token, "Bearer second-secret");

    features = { computerUse: true };
    await policy.setSession({ ...session, token: "third-secret" });
    assert.equal(await policy.standardCodeModeEnabled(), false, "a missing key is off");

    features = null;
    await policy.setSession({ ...session, token: "fourth-secret" });
    assert.equal(await policy.standardCodeModeEnabled(), false, "an unreachable Den is off");
  } finally {
    await policy.clearSession();
    await server.stop();
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
