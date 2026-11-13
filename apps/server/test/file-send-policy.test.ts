import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { serve } from "../src/serve-node.js";
import type { ServerConfig } from "../src/types.js";

const off = { enabled: false, scope: null, rules: [] };

test("file-send policy is verified with Den each time, keeps other actions out, and fails closed only where the rollout was on", async () => {
  const directory = await mkdtemp(join(tmpdir(), "file-send-policy-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(directory, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(directory, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  let enabled = false, unavailable = false, organizationId = "org_fixture";
  const sendRule = { action: "file_send", resource: "*", effect: "deny", source: "Everyone" };
  const rules = [sendRule, { action: "browser_upload", resource: "*", effect: "allow", source: "Everyone" }];
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    assert.equal(request.headers.get("X-OpenWork-File-Send-Permissions"), "1");
    return unavailable ? new Response(null, { status: 503 }) : Response.json({
      agentPermissions: { rules: enabled ? rules : [] }, fileSendPermissions: { enabled, organizationId, memberId: "member_fixture" },
    });
  } });
  const policy = managedDesktopPolicy(config);
  const session = { baseUrl: `http://127.0.0.1:${server.port}`, orgId: "org_fixture", token: "fixture-token" };
  try {
    assert.deepEqual(await policy.fileSendPolicy(), off, "signed out: each tool keeps its earlier prompt");
    await policy.setSession(session);
    assert.deepEqual(await policy.fileSendPolicy(), off, "rollout off");
    unavailable = true;
    assert.deepEqual(await policy.fileSendPolicy(), off, "Den unreachable with the rollout last seen off: earlier prompt, not a refusal");
    unavailable = false;

    enabled = true;
    assert.deepEqual(await policy.fileSendPolicy(), {
      enabled: true, scope: { baseUrl: session.baseUrl, organizationId: "org_fixture", memberId: "member_fixture" }, rules: [sendRule],
    });
    unavailable = true;
    await assert.rejects(policy.fileSendPolicy(), { code: "policy_unavailable" }, "an unverified Block or Ask first is never skipped");
    unavailable = false;

    organizationId = "org_other";
    await assert.rejects(policy.fileSendPolicy(), { code: "policy_identity_changed" });
  } finally {
    await policy.clearSession();
    await server.stop();
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
