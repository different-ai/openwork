import { expect, test } from "bun:test";
import { managedDesktopPolicy } from "./managed-desktop-policy.js";
import { executionRules, legacyExecutionPermissions, managedPolicyActionSchema } from "./managed-policy-rules.js";
import type { ServerConfig } from "./types.js";
import type { DesktopExecutionPolicy } from "@openwork/types/den/desktop-policies";

const config: ServerConfig = {
  host: "127.0.0.1", port: 0, token: "test", hostToken: "test",
  approval: { mode: "auto", timeoutMs: 30000 }, corsOrigins: [], workspaces: [], authorizedRoots: [],
  readOnly: false, startedAt: 0, tokenSource: "generated", hostTokenSource: "generated",
  logFormat: "pretty", logRequests: false,
};

test("v2 rules and legacy permissions ignore restrictive desktop execution config", () => {
  const execution: DesktopExecutionPolicy = { commands: "deny", blockedCommands: ["*"], browserOrigins: [], blockBrowserUploads: true };
  expect(executionRules(execution)).toEqual([]);
  expect(legacyExecutionPermissions(execution)).toEqual({});
});

test.each([401, 403, 503])("desktop actions never depend on policy verification (HTTP %i)", async (status) => {
  let requests = 0;
  const den = Bun.serve({ port: 0, fetch: () => {
    requests++;
    return new Response(null, { status });
  } });
  try {
    const service = managedDesktopPolicy({ ...config });
    for (const signedIn of [false, true, false]) {
      if (signedIn) await service.setSession({ baseUrl: `http://127.0.0.1:${den.port}`, token: "test", orgId: "org_test" });
      else await service.clearSession();
      expect(await service.current()).toBeNull();
      for (const action of managedPolicyActionSchema.options) {
        await expect(service.assert(action, {
          providerID: "ollama", modelID: "local-model", command: "curl https://example.com",
          url: "https://example.com", hasUpload: true, filePath: "/tmp/opencode.json",
        })).resolves.toBeUndefined();
      }
      for (const path of ["/opencode/auth/ollama", "/opencode/session/test/shell", "/opencode/pty", "/opencode/session/test/prompt_async", "/opencode/session", "/opencode/session/test/abort"]) {
        await expect(service.assertRequest(new Request(`http://localhost${path}`, { method: "POST" }), path, true))
          .resolves.toBeUndefined();
      }
    }
    expect(requests).toBe(0);
  } finally {
    den.stop(true);
  }
});

test("suspending policy does not remove evaluation endpoint authentication", () => {
  const service = managedDesktopPolicy({ ...config });
  expect(service.authenticatesEvaluation(new Request("http://localhost"))).toBe(false);
  expect(service.authenticatesEvaluation(new Request("http://localhost", { headers: { authorization: "Bearer wrong" } }))).toBe(false);
  expect(service.authenticatesEvaluation(new Request("http://localhost", { headers: { authorization: `Bearer ${service.evaluationToken}` } }))).toBe(true);
});
