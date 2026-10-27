import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { isRecord } from "../worlds/openwork-server-cli.ts";
import { managedProviderReconciliation, KEY, RESOURCE, MANAGED_SECRET, LOCAL_SECRET, PROVIDER_ID } from "../worlds/managed-provider-reconciliation.ts";

const test = spec.world(managedProviderReconciliation, { resources: { surfaces: [], services: [] }, needs: { commands: ["bun"] }, timeout: 240_000 });

test("managed models reconcile without treating a resource name as a credential or deleting a local key", async ({ world, step, evidence }) => {
  await step("before: a resource name alone cannot connect the managed provider", async () => {
    await world.sync();
    const status = await world.status();
    expect(status.providers).toEqual([]);
    expect(status.skippedProviders).toEqual(expect.arrayContaining([expect.objectContaining({ cloudProviderId: PROVIDER_ID, reason: "missing_credentials" })]));
    expect(world.requests).toContain(`/v1/llm-providers/${PROVIDER_ID}/connect`);
    evidence.recordAssertionEvidence("the missing-key condition was exercised", "Den returned only the resource name; the real server reports missing_credentials and no materialized provider.", Array.isArray(status.providers) && status.providers.length === 0);
  });
  await step("the delivered API key materializes every model setting without leaking the key into configuration", async () => {
    world.deliverCredential();
    await world.sync();
    const config = await world.config();
    const providers = isRecord(config.provider) ? config.provider : {};
    expect(providers[PROVIDER_ID]).toMatchObject({
      env: [RESOURCE, KEY], npm: "@ai-sdk/openai-compatible", whitelist: ["kept"],
      models: { kept: { name: "Kept 1", reasoning: true, tool_call: true, limit: { context: 32000, output: 1024 }, cost: { input: 1, output: 2 }, options: { temperature: 0.3 }, headers: { "x-fixture-model": "kept" }, variants: { careful: { reasoningEffort: "high" } } } },
    });
    expect(await world.env(KEY)).toMatchObject({ status: 200, body: { item: { value: MANAGED_SECRET } } });
    expect(JSON.stringify(config)).not.toContain(MANAGED_SECRET);
    expect(JSON.stringify(await world.status())).not.toContain(MANAGED_SECRET);
    evidence.recordAssertionEvidence("configuration and credentials remain separate", "The runtime retains model limits, cost, options, headers and variants; the API key is in the env store and absent from runtime configuration and public sync status.", !JSON.stringify(config).includes(MANAGED_SECRET));
  });
  await step("changed models replace the old catalog and an unchanged pass stays idempotent", async () => {
    world.changeModels();
    await world.sync();
    const config = await world.config();
    const providers = isRecord(config.provider) ? config.provider : {};
    const provider = isRecord(providers[PROVIDER_ID]) ? providers[PROVIDER_ID] : {};
    expect(Object.keys(isRecord(provider.models) ? provider.models : {})).toEqual(["kept"]);
    expect(provider.models).toMatchObject({ kept: { name: "Kept 2" } });
    const again = await world.sync();
    expect(again.body.status).toBe("noop");
    expect(await world.config()).toEqual(config);
    evidence.recordAssertionEvidence("updates do not leave stale models or churn unchanged configuration", "The removed model disappeared, the retained model was updated, and repeating sync returned noop with identical configuration.", again.body.status === "noop");
  });
  await step("after: removing the grant removes managed configuration but preserves the member's replacement key", async () => {
    await world.setLocalKey();
    world.removeProvider();
    await world.sync();
    const config = await world.config();
    expect(isRecord(config.provider) ? config.provider[PROVIDER_ID] : undefined).toBeUndefined();
    expect(await world.env(KEY)).toMatchObject({ status: 200, body: { item: { value: LOCAL_SECRET } } });
    expect((await world.env(RESOURCE)).status).toBe(404);
    evidence.recordAssertionEvidence("cleanup respects local credential ownership", "The managed provider and its owned resource variable were removed; a locally replaced API key remained unchanged.", !(isRecord(config.provider) && PROVIDER_ID in config.provider));
  });
});
