import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { serve } from "../src/serve-node.js";
import type { ServerConfig } from "../src/types.js";

// Native v2 external connections must obey the same model-access rule as API keys.
test("an organization that only allows assigned models also blocks native provider sign-in", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-integration-policy-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(directory, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(directory, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  let allowCustomProviders = false;
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ allowCustomProviders }) });
  const policy = managedDesktopPolicy(config);
  const request = (method: string, path: string) => new Request(`http://localhost${path}`, {
    method,
    ...(method === "POST" ? { headers: { "content-type": "application/json" }, body: JSON.stringify({ method: "claude-login" }) } : {}),
  });
  try {
    await policy.setSession({ baseUrl: `http://127.0.0.1:${server.port}`, token: "test-token", orgId: "org_test" });
    await policy.current();
    for (const path of [
      "/opencode2/api/integration/claude-agent/connect/external",
      "/opencode2/api/integration/openai/connect/external",
      "/opencode2/api/integration/claude%2Dagent/connect/external",
    ]) {
      await assert.rejects(policy.assertRequest(request("POST", path), path, true), { code: "organization_policy_denied" });
    }
    const read = "/opencode2/api/integration/claude-agent";
    await policy.assertRequest(request("GET", read), read, true);
    const managed = "/opencode2/api/integration/ipr_fixture/connection";
    await policy.assertRequest(request("POST", managed), managed, true);
    const model = "/opencode2/api/session/ses_test/model";
    await assert.rejects(policy.assertRequest(new Request(`http://localhost${model}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: { providerID: "claude-agent", id: "sonnet" } }),
    }), model, true), { code: "organization_model_denied" });

    allowCustomProviders = true;
    await policy.current();
    const connect = "/opencode2/api/integration/claude-agent/connect/external";
    await policy.assertRequest(request("POST", connect), connect, true);
  } finally {
    await policy.clearSession();
    await server.stop();
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
