import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { ACME_MODEL } from "../../worlds/lib/acme-gateway.ts";
import { gatewayProviderTestWorld } from "../worlds/gateway-provider-test.ts";
import { isRecord } from "./../worlds/library.ts";

const test = spec.world(gatewayProviderTestWorld, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

test("an admin tests a shared-key provider through AI Gateway before adding it", async ({ world, user, probe, step, evidence }) => {
  await step("before: a new shared-key provider offers Test in place of Add", async () => {
    await user.see({ testId: "gateway-provider-title" }, { text: "Add Anthropic", timeoutMs: 60_000 });
    await user.see({ testId: "gateway-provider-test" }, { text: "Test Anthropic", timeoutMs: 60_000 });
    await user.notSee({ testId: "gateway-provider-save" });
    await user.see({ testId: "gateway-provider-title-rename" });
    await user.screenshot();
  });

  await step("the admin renames the provider in the title, and Escape undoes an edit", async () => {
    await user.click({ testId: "gateway-provider-title-rename" });
    await user.see({ testId: "gateway-provider-title-done" });
    await user.type({ testId: "gateway-provider-title-input" }, "Anthropic research", { replace: true });
    await user.screenshot();
    await user.click({ testId: "gateway-provider-title-done" });
    await user.see({ testId: "gateway-provider-title" }, { text: "Add Anthropic research" });
    await user.see({ testId: "gateway-provider-title-rename" });
    await user.screenshot();
    await user.click({ testId: "gateway-provider-title" });
    await user.type({ testId: "gateway-provider-title-input" }, "Throwaway", { replace: true });
    await user.press("Escape");
    await user.see({ testId: "gateway-provider-title" }, { text: "Add Anthropic research" });
  });

  await step("testing without a key shows a red message, and changing the key dismisses it", async () => {
    await user.click({ testId: "gateway-provider-test" });
    await user.see({ testId: "gateway-provider-test-result" }, { text: "Paste a key to test." });
    await user.screenshot();
    await user.type({ testId: "gateway-provider-api-key" }, "sk-ant-not-a-real-key", { sensitive: true });
    await probe.eventually(() => probe.has("Paste a key to test."), { within: 10_000, until: (present) => !present });
    await user.notSee({ testId: "gateway-provider-test-result" });
    await user.see({ testId: "gateway-provider-test" }, { text: "Test Anthropic" });
  });

  const body = (key: string) => ({ providerId: "anthropic", model: ACME_MODEL, settings: { upstreamBaseUrl: `${world.upstream.baseUrl}/v1` }, credential: { kind: "api_key", secret: key } });

  await step("the gateway sends one test prompt with the right key and the provider answers", async () => {
    const before = world.upstream.requests.length;
    const tested = await world.testConnection(body(world.upstream.key));
    expect(tested.response.status).toBe(200);
    expect(isRecord(tested.body) && tested.body.ok).toBe(true);
    expect(world.upstream.requests.slice(before)).toEqual([{ model: ACME_MODEL, authenticated: true }]);
    const reached = world.upstream.requests.slice(before).every((request) => request.authenticated && request.model === ACME_MODEL);
    evidence.recordAssertionEvidence("the test prompt reached the provider with the pasted key", JSON.stringify(tested.body), reached);
  });

  await step("a wrong key fails with a plain message that never contains the key", async () => {
    const wrongKey = "sk-ant-wrong-fixture-key-0000";
    const tested = await world.testConnection(body(wrongKey));
    expect(tested.response.status).toBe(200);
    expect(isRecord(tested.body) && tested.body.ok).toBe(false);
    expect(isRecord(tested.body) && tested.body.code).toBe("provider_authentication_failed");
    expect(tested.text).not.toContain(wrongKey);
    evidence.recordAssertionEvidence("a rejected key is reported without echoing it", JSON.stringify(tested.body), !tested.text.includes(wrongKey));
  });

  await step("a custom address the operator did not allow is never contacted", async () => {
    const before = world.upstream.requests.length;
    const tested = await world.testConnection({ providerId: "anthropic", model: ACME_MODEL, settings: { upstreamBaseUrl: "https://example.com/v1" }, credential: { kind: "api_key", secret: world.upstream.key } });
    expect(isRecord(tested.body) && tested.body.code).toBe("invalid_settings");
    expect(world.upstream.requests.length).toBe(before);
  });
});
