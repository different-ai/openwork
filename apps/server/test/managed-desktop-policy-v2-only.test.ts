import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { serve } from "../src/serve-node.js";
import type { ServerConfig } from "../src/types.js";

function deferred<T>() {
  let resolve: ((value: T) => void) | undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve: (value: T) => resolve?.(value) };
}

test("v2-only rollout updates independently of persisted policy and ignores stale identity reads", async () => {
  const dir = await mkdtemp(join(tmpdir(), "openwork-v2-only-policy-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(dir, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(dir, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  let response = () => Response.json({ allowCustomProviders: false, opencodeV2Only: true });
  let held: { started: ReturnType<typeof deferred<void>>; response: ReturnType<typeof deferred<Response>> } | undefined;
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: () => {
    if (held) {
      const pending = held;
      held = undefined;
      pending.started.resolve();
      return pending.response.promise;
    }
    return response();
  } });
  const policy = managedDesktopPolicy(config);
  const updates: boolean[] = [];
  let configChanges = 0;
  policy.onV2OnlyChange = (enabled) => { updates.push(enabled); };
  policy.onChange = () => { configChanges++; };
  const session = { baseUrl: `http://127.0.0.1:${server.port}`, token: "test-secret", orgId: "org_test" };
  try {
    await policy.setSession(session);
    await policy.current();
    assert.equal(updates.at(-1), true);
    const initialChanges = configChanges;
    const initialUpdates = updates.length;
    await policy.current();
    assert.equal(updates.length, initialUpdates + 1, "each verified read reports rollout state");
    assert.equal(configChanges, initialChanges, "unchanged persisted policy does not fire onChange");

    response = () => Response.json({ allowCustomProviders: false, opencodeV2Only: false });
    await policy.current();
    assert.equal(updates.at(-1), false);
    response = () => Response.json({ allowCustomProviders: false });
    await policy.current();
    assert.equal(updates.at(-1), false, "missing rollout field means off");
    response = () => Response.json({ allowCustomProviders: false, opencodeV2Only: true });
    await policy.current();
    response = () => new Response(null, { status: 500 });
    const fallback = await policy.current();
    assert.equal(updates.at(-1), false);
    assert.equal(fallback?.allowCustomProviders, false, "offline access policy stays intact");
    assert.equal(fallback?.opencodeV2Only, false, "offline cached rollout cannot stay on");

    response = () => Response.json({ allowCustomProviders: false, opencodeV2Only: true });
    await policy.current();
    const pending = { started: deferred<void>(), response: deferred<Response>() };
    held = pending;
    const staleRead = policy.current();
    const rejected = assert.rejects(staleRead, { code: "policy_identity_changed" });
    await pending.started.promise;
    response = () => Response.json({ allowCustomProviders: false, opencodeV2Only: false });
    const switched = policy.setSession({ ...session, token: "other-secret" });
    assert.equal(updates.at(-1), false, "identity switch revokes synchronously");
    await switched;
    await policy.current();
    const afterSwitch = updates.length;
    pending.response.resolve(Response.json({ opencodeV2Only: true }));
    await rejected;
    assert.equal(updates.length, afterSwitch, "old identity success cannot publish rollout state");

    const failed = { started: deferred<void>(), response: deferred<Response>() };
    held = failed;
    const staleFailure = policy.current();
    const failedRead = assert.rejects(staleFailure, { code: "policy_identity_changed" });
    await failed.started.promise;
    response = () => Response.json({ allowCustomProviders: false, opencodeV2Only: true });
    await policy.setSession(session);
    await policy.current();
    assert.equal(updates.at(-1), true);
    const afterRecovery = updates.length;
    failed.response.resolve(new Response(null, { status: 500 }));
    await failedRead;
    assert.equal(updates.length, afterRecovery, "old identity failure cannot revoke current rollout");

    const cleared = policy.clearSession();
    assert.equal(updates.at(-1), false, "sign-out revokes synchronously");
    await cleared;
  } finally {
    await server.stop();
    await policy.clearSession();
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
