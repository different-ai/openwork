import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { BEDROCK_NAME, bedrockGuardrailsOffWorld, bedrockGuardrailsOnWorld } from "../worlds/bedrock-guardrails.ts";
import { isRecord } from "../worlds/library.ts";

const testOff = spec.world(bedrockGuardrailsOffWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const testOn = spec.world(bedrockGuardrailsOnWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const WITHIN = 60_000;
const IDENTIFIER = "abc123def456";
const VERSION = "3";
const PAIR_ERROR = "Enter both the guardrail ID or ARN and its version, or leave both empty.";
const ERROR_NOTICE = '[role="alert"][data-notice-tone="error"]';

// The default-off organization is a separate seeded identity, not a browser-only flag override.
testOff("an owner outside the Bedrock guardrail rollout keeps the existing provider editor", async ({ world, user, probe, step, evidence }) => {
  await step("before: Bedrock still offers its existing key and region settings", async () => {
    await user.see({ testId: "gateway-provider-save" }, { timeoutMs: WITHIN });
    await user.see({ testId: "gateway-setting-region" });
    const region = (await probe.dom('[data-testid="gateway-setting-region"][value="us-east-1"]')).elements.length;
    expect(region).toBe(1);
    evidence.recordAssertionEvidence("The existing provider editor is available", "Bedrock region us-east-1 and Save changes are visible.", region === 1);
    await user.screenshot();
  });
  await step("the owner cannot see guardrail controls before rollout", async () => {
    await user.notSee({ testId: "gateway-bedrock-guardrails" });
    const fields = (await probe.dom('[data-testid="gateway-setting-guardrailIdentifier"], [data-testid="gateway-setting-guardrailVersion"]')).elements.length;
    expect(fields).toBe(0);
    evidence.recordAssertionEvidence("Guardrail settings stay hidden with the flag off", `${fields} guardrail fields in the editor.`, fields === 0);
    await user.screenshot();
  });
  await step("after: reloading does not opt the organization into guardrails", async () => {
    await user.reload();
    await user.see({ testId: "gateway-provider-save" }, { timeoutMs: WITHIN });
    await user.notSee({ testId: "gateway-bedrock-guardrails" });
    const { response, body } = await probe.api(world.den.admin, world.providerPath);
    expect(response.status).toBe(200);
    if (!isRecord(body) || !isRecord(body.inferenceProvider)) throw new Error("Expected saved Bedrock provider details.");
    expect(body.inferenceProvider.settings).toEqual({ region: "us-east-1" });
    evidence.recordAssertionEvidence("The unrolled organization remains unchanged", "Reload keeps guardrails hidden; saved provider still has only region us-east-1.", response.status === 200);
  });
});

testOn("an owner in the rollout saves a Bedrock guardrail and reopens the same configuration", async ({ world, user, probe, step, evidence }) => {
  const readProvider = async () => {
    const { response, body } = await probe.api(world.den.admin, world.providerPath);
    expect(response.status).toBe(200);
    if (!isRecord(body) || !isRecord(body.inferenceProvider)) throw new Error("Expected saved Bedrock provider details.");
    return body.inferenceProvider;
  };

  await step("before: the opted-in owner sees an optional Bedrock guardrail with empty fields", async () => {
    await user.see({ testId: "gateway-bedrock-guardrails" }, { timeoutMs: WITHIN });
    await user.see({ testId: "gateway-setting-guardrailIdentifier" });
    await user.see({ testId: "gateway-setting-guardrailVersion" });
    const provider = await readProvider();
    expect(provider.settings).toEqual({ region: "us-east-1" });
    evidence.recordAssertionEvidence("Guardrails are optional until the owner configures them", "Both guardrail fields are visible; the saved provider has only its us-east-1 region.", isRecord(provider.settings) && !provider.settings.guardrailIdentifier && !provider.settings.guardrailVersion);
    await user.screenshot();
  });

  await step("the owner cannot save a guardrail identifier without its version", async () => {
    await user.type({ testId: "gateway-setting-guardrailIdentifier" }, IDENTIFIER);
    await user.click({ testId: "gateway-provider-save" });
    await user.see({ text: PAIR_ERROR }, { timeoutMs: WITHIN });
    expect(new URL(await probe.url()).pathname).toContain("/providers/");
    const provider = await readProvider();
    expect(provider.settings).toEqual({ region: "us-east-1" });
    evidence.recordAssertionEvidence("An incomplete pair stays unsaved", `${PAIR_ERROR} Saved provider still has no guardrail.`, isRecord(provider.settings) && !provider.settings.guardrailIdentifier);
    await user.screenshot();
  });

  await step("when the owner supplies both values and saves, Bedrock returns to AI Providers", async () => {
    await user.type({ testId: "gateway-setting-guardrailVersion" }, VERSION);
    await user.click({ testId: "gateway-provider-save" });
    const outcome = await probe.eventually(async () => ({
      route: new URL(await probe.url()),
      errors: (await probe.dom(ERROR_NOTICE)).elements.map((element) => element.text),
    }), {
      within: WITHIN, label: "the Bedrock provider save finishes",
      until: ({ route, errors }) => errors.length > 0 || (route.pathname.endsWith("/dashboard/ai-gateway") && route.searchParams.get("tab") === "ai-providers"),
    });
    expect(outcome.errors).toEqual([]);
    await user.see({ text: BEDROCK_NAME }, { timeoutMs: WITHIN });
    const provider = await readProvider();
    expect(provider.settings).toEqual({ region: "us-east-1", guardrailIdentifier: IDENTIFIER, guardrailVersion: VERSION });
    evidence.recordAssertionEvidence("The paired guardrail is persisted without changing region", `Guardrail ${IDENTIFIER}, version ${VERSION}, region us-east-1; no save error.`, isRecord(provider.settings) && provider.settings.guardrailIdentifier === IDENTIFIER && provider.settings.guardrailVersion === VERSION);
    await user.screenshot();
  });

  await step("after: reopening and reloading Bedrock retains the guardrail identifier and version", async () => {
    await user.navigate(world.editorUrl);
    await user.see({ testId: "gateway-setting-guardrailIdentifier" }, { timeoutMs: WITHIN });
    await user.reload();
    await user.see({ testId: "gateway-setting-guardrailVersion" }, { timeoutMs: WITHIN });
    const identifier = (await probe.dom(`[data-testid="gateway-setting-guardrailIdentifier"][value="${IDENTIFIER}"]`)).elements.length;
    const version = (await probe.dom(`[data-testid="gateway-setting-guardrailVersion"][value="${VERSION}"]`)).elements.length;
    expect(identifier).toBe(1);
    expect(version).toBe(1);
    expect((await probe.dom(ERROR_NOTICE)).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("A fresh editor reload restores both saved fields", `Guardrail ID ${IDENTIFIER} and version ${VERSION} are displayed after reopening and reloading.`, identifier === 1 && version === 1);
    await user.screenshot();
  });
});
