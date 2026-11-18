import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { calculateEffectiveDesktopPolicy, isRestrictedDesktopPolicyValue, normalizeDefaultDesktopPolicyValue } from "@openwork/types/den/desktop-policies-runtime";
import { managedDesktopPolicy } from "../src/managed-desktop-policy.js";
import { buildOpenworkRuntimeConfigObjectFromSnapshot } from "../src/openwork-runtime-config.js";
import { organizationProviderGate } from "../src/organization-provider-gate.js";
import { serve } from "../src/serve-node.js";
import type { ServerConfig } from "../src/types.js";

const provider = { ipr_team: { npm: "@ai-sdk/openai-compatible", models: {} }, ollama: { npm: "@ai-sdk/openai-compatible", models: {} }, anthropic: { models: {} } };

test("policies saved before the switch existed keep what the provider setting meant for local models", () => {
  // "Only models you provide" blocked Ollama before; the admin exception allowed it.
  assert.equal(normalizeDefaultDesktopPolicyValue({ allowCustomProviders: false }).allowLocalModels, false);
  assert.equal(normalizeDefaultDesktopPolicyValue({ allowCustomProviders: true }).allowLocalModels, true);
  assert.equal(normalizeDefaultDesktopPolicyValue({}).allowLocalModels, true);
  const admins = calculateEffectiveDesktopPolicy({ orgPolicyCount: 2, defaultPolicy: { allowCustomProviders: false }, assignedPolicies: [{ allowCustomProviders: true }] });
  assert.equal(admins.allowLocalModels, true, "an existing admin exception still lets admins use Ollama");
  // An existing Restricted default still reads as Restricted.
  const restricted = normalizeDefaultDesktopPolicyValue({ allowCustomProviders: false, allowZenModel: false, allowMultipleWorkspaces: false, allowControlSettings: false, allowManageExtensions: false, allowBuiltInExtensions: false, allowAlphaUpdates: false });
  assert.equal(isRestrictedDesktopPolicyValue(restricted), true);
  // The new switch, once saved, decides on its own.
  assert.equal(normalizeDefaultDesktopPolicyValue({ allowCustomProviders: true, allowLocalModels: false }).allowLocalModels, false);
  assert.equal(normalizeDefaultDesktopPolicyValue({ allowCustomProviders: false, allowLocalModels: true }).allowLocalModels, true);
});

test("both engines follow the local models switch in either model access mode", () => {
  const cases: Array<{ policy: Record<string, boolean> | undefined; ollama: boolean; anthropic: boolean }> = [
    { policy: undefined, ollama: true, anthropic: true },
    { policy: { allowCustomProviders: true }, ollama: true, anthropic: true },
    { policy: { allowCustomProviders: true, allowLocalModels: false }, ollama: false, anthropic: true },
    { policy: { allowCustomProviders: false }, ollama: false, anthropic: false },
    { policy: { allowCustomProviders: false, allowLocalModels: true }, ollama: true, anthropic: false },
    { policy: { allowCustomProviders: false, allowLocalModels: false }, ollama: false, anthropic: false },
  ];
  for (const { policy, ollama, anthropic } of cases) {
    const label = JSON.stringify(policy);
    const allows = organizationProviderGate(policy);
    const allowed = (id: string) => allows === null || allows(id);
    assert.equal(allowed("ollama"), ollama, `v2 ollama ${label}`);
    assert.equal(allowed("lmstudio"), ollama, `v2 lmstudio ${label}`);
    assert.equal(allowed("anthropic"), anthropic, `v2 anthropic ${label}`);
    assert.equal(allowed("ipr_team"), true, `v2 organization ${label}`);
    // v1: an allowlist under "Only models you provide", otherwise a denylist.
    const v1 = buildOpenworkRuntimeConfigObjectFromSnapshot({ provider, ...(policy ? { managedPolicy: policy } : {}) });
    const enabled = Array.isArray(v1.enabled_providers) ? v1.enabled_providers : null;
    const disabled = Array.isArray(v1.disabled_providers) ? v1.disabled_providers : [];
    const v1Allowed = (id: string) => (enabled === null || enabled.includes(id)) && !disabled.includes(id);
    assert.equal(v1Allowed("ollama"), ollama, `v1 ollama ${label}`);
    assert.equal(v1Allowed("anthropic"), anthropic, `v1 anthropic ${label}`);
    assert.equal(v1Allowed("ipr_team"), true, `v1 organization ${label}`);
  }
});

test("the local server refuses adding or sending with Ollama only while local models are off", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openwork-local-models-"));
  const previous = process.env.OPENWORK_RUNTIME_DB;
  process.env.OPENWORK_RUNTIME_DB = join(directory, "runtime.sqlite");
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host-test", configPath: join(directory, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: [], workspaces: [], authorizedRoots: [], readOnly: false,
    startedAt: Date.now(), tokenSource: "generated", hostTokenSource: "generated", logFormat: "json", logRequests: false,
  };
  let answer: Record<string, unknown> = { allowCustomProviders: true, allowLocalModels: false };
  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(answer) });
  const policy = managedDesktopPolicy(config);
  const send = (providerID: string) => {
    const path = "/opencode2/api/session/ses_test/message";
    return policy.assertRequest(new Request(`http://localhost${path}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: { providerID, id: "qwen" } }),
    }), path, true);
  };
  try {
    await policy.setSession({ baseUrl: `http://127.0.0.1:${server.port}`, token: "test-token", orgId: "org_test" });
    await policy.current();
    // Settings › Ollama writes the provider through the server's config route.
    await assert.rejects(policy.assert("provider", { providerIDs: ["ollama"] }), { code: "organization_local_models_denied" });
    await assert.rejects(policy.assert("provider", { providerIDs: ["lmstudio"] }), { code: "organization_local_models_denied" });
    await assert.rejects(send("ollama"), { code: "organization_local_models_denied" });
    // Everything else is unchanged: personal keys are still allowed.
    await policy.assert("provider", { providerIDs: ["anthropic"] });
    await send("anthropic");

    // "Only models you provide" with local models on: Ollama yes, personal keys no.
    answer = { allowCustomProviders: false, allowLocalModels: true };
    await policy.current();
    await policy.assert("provider", { providerIDs: ["ollama"] });
    await send("ollama");
    await assert.rejects(policy.assert("provider", { providerIDs: ["anthropic"] }), { code: "organization_policy_denied" });

    // An older Den without the key: "Only models you provide" still blocks Ollama, as before.
    answer = { allowCustomProviders: false };
    await policy.current();
    await assert.rejects(send("ollama"), { code: "organization_local_models_denied" });

    answer = { allowCustomProviders: true };
    await policy.current();
    await policy.assert("provider", { providerIDs: ["ollama"] });
    await send("ollama");
  } finally {
    await policy.clearSession();
    await server.stop();
    if (previous === undefined) delete process.env.OPENWORK_RUNTIME_DB;
    else process.env.OPENWORK_RUNTIME_DB = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
