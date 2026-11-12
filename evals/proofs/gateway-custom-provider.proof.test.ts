import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { CUSTOM_MODEL, MATCHED_MODEL, MOCK_REPLY, NEW_MODEL, UNMATCHED_MODEL, gatewayCustomProviderWorld } from "../worlds/gateway-custom-provider.ts";
import { isRecord } from "../worlds/library.ts";

const test = spec.world(gatewayCustomProviderWorld, { resources: { surfaces: ["web"], services: ["den"] }, timeout: 900_000 });

const row = (modelId: string) => `[data-testid="custom-model-row"][data-model-id="${modelId}"]`;
const PROVIDER_NAME = "Acme AI";
/** Visible text that contains `part` (see compares whole text otherwise). */
const contains = (part: string) => new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

test("an admin adds an OpenAI-compatible provider by address and key, and a member chats with its models", async ({ world, user, probe, step, evidence }) => {
  /** Waits for an element in a given state (data-* attributes the UI renders), up to `within` ms. */
  const shown = (selector: string, within = 15_000) => probe.eventually(async () => (await probe.dom(selector)).elements.length, { within, label: selector, until: (count) => count > 0 });
  await step("the admin opens Another provider and fills in the connection", async () => {
    await user.click({ testId: "gateway-provider-pick-custom" });
    await shown('[data-testid="custom-provider-wizard"][data-step="1"]', 60_000);
    await user.type({ testId: "custom-provider-name" }, PROVIDER_NAME);
    await user.type({ testId: "custom-provider-base-url" }, `${world.upstream.baseUrl}/v1/chat/completions`);
    // A wrong key: the provider lists its models without one, but refuses to answer with it.
    await user.type({ testId: "custom-provider-api-key" }, "sk-acme-wrong-fixture-key-0000", { sensitive: true });
    await user.see({ testId: "custom-provider-endpoint" }, { text: contains(`${world.upstream.baseUrl}/v1/chat/completions`) });
    await user.see({ testId: "gateway-provider-title" }, { text: `Add ${PROVIDER_NAME}` });
    await user.screenshot();
  });

  await step("fetching models shows a loading line, then a detailed list with one model matched to models.dev", async () => {
    await user.click({ testId: "custom-provider-next" });
    await user.see({ testId: "custom-provider-discovery-loading" }, { text: contains(`Fetching models from ${PROVIDER_NAME}`), timeoutMs: 10_000 });
    await shown('[data-testid="custom-provider-discovery-result"][data-status="detailed"]', 60_000);
    await user.see({ testId: "custom-provider-discovery-result" }, { text: contains("listed 2 models with their details") });
    await user.screenshot();
  });

  await step("the matched model is ticked with its settings; the unknown one needs settings", async () => {
    await user.click({ testId: "custom-provider-next" });
    await shown(`${row(MATCHED_MODEL)}[data-selected="true"]`, 30_000);
    await shown(`${row(MATCHED_MODEL)} [data-testid="custom-model-matched"]`);
    await shown(`${row(UNMATCHED_MODEL)}[data-selected="false"] [data-testid="custom-model-needs-settings"]`);
    const matched = (await probe.dom(`${row(MATCHED_MODEL)}[data-selected="true"] [data-testid="custom-model-matched"]`)).elements.length;
    const needsSettings = (await probe.dom(`${row(UNMATCHED_MODEL)}[data-selected="false"] [data-testid="custom-model-needs-settings"]`)).elements.length;
    evidence.recordAssertionEvidence("models.dev matching", `${MATCHED_MODEL}: Matched, ticked · ${UNMATCHED_MODEL}: Needs settings, not ticked`, matched === 1 && needsSettings === 1);
  });

  await step("the admin adds a model the provider did not list, with every setting in the full form", async () => {
    await user.click({ testId: "custom-model-add-custom" });
    await user.see({ testId: "custom-model-field-id" });
    await user.type({ testId: "custom-model-field-id" }, CUSTOM_MODEL);
    await user.type({ testId: "custom-model-field-name" }, "Acme House Chat");
    await user.type({ testId: "custom-model-field-context" }, "64000");
    await user.type({ testId: "custom-model-field-outputLimit" }, "8000");
    await shown(`${row(CUSTOM_MODEL)}[data-selected="true"]`);
    await user.screenshot();
  });

  await step("a test with the wrong key fails and sends the admin back to the connection, with everything still filled in", async () => {
    await user.click({ testId: "custom-provider-next" });
    await shown('[data-testid="custom-provider-wizard"][data-step="4"]', 10_000);
    const before = world.upstream.completions.length;
    await user.click({ testId: "custom-provider-test" });
    await shown('[data-testid="custom-provider-wizard"][data-step="1"]', 60_000);
    await user.see({ testId: "custom-provider-api-key-error" }, { timeoutMs: 10_000 });
    await user.see({ testId: "custom-provider-name" }, { value: PROVIDER_NAME });
    await user.see({ testId: "custom-provider-base-url" }, { value: `${world.upstream.baseUrl}/v1/chat/completions` });
    const sent = world.upstream.completions.slice(before);
    expect(sent).toEqual([{ model: MATCHED_MODEL, authenticated: false }]);
    evidence.recordAssertionEvidence("the test prompt reached the provider and was refused", JSON.stringify(sent), sent.length === 1 && !sent[0]?.authenticated);
    await user.screenshot();
  });

  await step("with the right key the test passes and the admin adds the provider", async () => {
    await user.type({ testId: "custom-provider-api-key" }, world.upstream.key, { sensitive: true, replace: true });
    await user.click({ testId: "custom-provider-next" });
    await shown('[data-testid="custom-provider-discovery-result"][data-status="detailed"]', 60_000);
    await user.click({ testId: "custom-provider-next" });
    // Models and the hand-made one survive the round trip.
    await shown(`${row(CUSTOM_MODEL)}[data-selected="true"]`, 10_000);
    await shown(`${row(MATCHED_MODEL)}[data-selected="true"]`);
    await user.click({ testId: "custom-provider-next" });
    const before = world.upstream.completions.length;
    await user.click({ testId: "custom-provider-test" });
    await shown('[data-testid="custom-provider-test-result"][data-ok="true"]', 60_000);
    await user.see({ testId: "custom-provider-add" }, { text: `Add ${PROVIDER_NAME}` });
    const sent = world.upstream.completions.slice(before);
    expect(sent).toEqual([{ model: MATCHED_MODEL, authenticated: true }]);
    await user.screenshot();
    await user.click({ testId: "custom-provider-add" });
    await user.see({ testId: "gateway-provider-row" }, { text: contains(PROVIDER_NAME), timeoutMs: 60_000 });
    await user.see({ testId: "gateway-provider-row" }, { text: contains("2 models") });
    await user.screenshot();
  });

  const providerId = await step("on the provider's page, Re-fetch models offers the model the provider now lists, and the admin saves it", async () => {
    const listed = await world.providers();
    const providers = isRecord(listed.body) && Array.isArray(listed.body.inferenceProviders) ? listed.body.inferenceProviders.filter(isRecord) : [];
    const saved = providers.find((entry) => entry.name === PROVIDER_NAME);
    expect(typeof saved?.id).toBe("string");
    const id = String(saved?.id);
    world.upstream.listNewModel();
    await user.click({ label: `Manage ${PROVIDER_NAME}` });
    await user.see({ testId: "custom-provider-manage" }, { timeoutMs: 60_000 });
    await user.click({ testId: "custom-provider-refetch" });
    await user.see({ testId: "custom-provider-refetch-result" }, { text: contains("2 new models to add"), timeoutMs: 60_000 });
    await shown(`${row(NEW_MODEL)}[data-selected="false"]`);
    await user.click({ label: "Include OpenAI: GPT-4o" });
    await shown(`${row(NEW_MODEL)}[data-selected="true"]`);
    // A new model id must answer before it is saved.
    await user.click({ testId: "custom-provider-test" });
    await shown('[data-testid="custom-provider-test-result"][data-ok="true"]', 60_000);
    await user.screenshot();
    await user.click({ testId: "custom-provider-save" });
    await user.see({ testId: "gateway-provider-row" }, { text: contains("3 models"), timeoutMs: 60_000 });
    const after = await world.providers();
    const savedAfter = isRecord(after.body) && Array.isArray(after.body.inferenceProviders) ? after.body.inferenceProviders.filter(isRecord).find((entry) => entry.id === id) : undefined;
    const modelIds = isRecord(savedAfter?.custom) && Array.isArray(savedAfter.custom.models) ? savedAfter.custom.models.filter(isRecord).map((model) => String(model.id)) : [];
    expect(modelIds).toContain(NEW_MODEL);
    evidence.recordAssertionEvidence("the re-fetched model is saved", `saved models: ${modelIds.join(", ")}`, modelIds.includes(NEW_MODEL));
    return id;
  });

  await step("after: a member's chat request goes through AI Gateway to the provider with the hand-made model's id", async () => {
    const before = world.upstream.completions.length;
    const chat = await world.memberChat(providerId, CUSTOM_MODEL, "Acme House Chat");
    expect(chat.connectStatus).toBe(200);
    expect(chat.status, `member models ${chat.modelIds.join(", ")}; ${chat.text.slice(0, 300)}`).toBe(200);
    expect(chat.text).toContain(MOCK_REPLY);
    expect(chat.text).not.toContain(world.upstream.key);
    const sent = world.upstream.completions.slice(before);
    expect(sent).toEqual([{ model: CUSTOM_MODEL, authenticated: true }]);
    evidence.recordAssertionEvidence(
      "the provider received the member's request with the saved key and the model id the admin typed",
      `member sees ${chat.modelIds.join(", ")} · gateway HTTP ${chat.status} · provider got ${JSON.stringify(sent)}`,
      sent.length === 1 && sent[0]?.model === CUSTOM_MODEL && sent[0]?.authenticated === true,
    );
  });

  await step("a private network address is refused before anything is contacted, with a plain message", async () => {
    const listsBefore = world.upstream.modelListRequests.length;
    const refused = await world.discover({ baseUrl: "http://10.0.0.1/v1", apiKey: "sk-private-fixture" });
    expect(refused.response.status).toBe(400);
    expect(refused.text).toContain("Private networks");
    await user.navigate(`${world.den.ref.webUrl}/dashboard/ai-gateway/providers/new/custom`);
    await shown('[data-testid="custom-provider-wizard"][data-step="1"]', 60_000);
    await user.type({ testId: "custom-provider-name" }, "Office server");
    await user.type({ testId: "custom-provider-base-url" }, "http://10.0.0.1/v1");
    await user.type({ testId: "custom-provider-api-key" }, "sk-private-fixture", { sensitive: true });
    await user.click({ testId: "custom-provider-next" });
    await user.see({ testId: "custom-provider-discovery-error" }, { text: contains("Private networks"), timeoutMs: 60_000 });
    expect(world.upstream.modelListRequests.length).toBe(listsBefore);
    await probe.eventually(() => probe.has("Office server"), { within: 5_000, until: (present) => present });
    evidence.recordAssertionEvidence("a private address is refused", `discover-models → HTTP ${refused.response.status}: ${refused.text.slice(0, 160)}`, refused.response.status === 400);
    await user.screenshot();
  });
});
