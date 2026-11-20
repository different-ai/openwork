import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { gatewayProviderEditorSaveWorld, VERTEX_PILOT_NAME } from "../worlds/gateway-provider-editor-save.ts";
import { isRecord } from "../worlds/library.ts";

const test = spec.world(gatewayProviderEditorSaveWorld, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });
const WITHIN = 60_000;
const CLIENT_ID = "example-oauth-client-id";
const RENAMED = `${VERTEX_PILOT_NAME} rollout`;
const PICKER_ROWS = 'input[type="checkbox"][data-testid^="gateway-model-"]';
const ERROR_NOTICE = '[role="alert"][data-notice-tone="error"]';

function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(isRecord)) throw new Error("Expected a list of records in the Den response.");
  return value;
}

function modelIds(models: Record<string, unknown>[]): string[] {
  return models.map((model) => {
    if (typeof model.id !== "string") throw new Error("Expected a model ID in the Den response.");
    return model.id;
  }).sort();
}

test("an owner can share all supported Vertex models with everyone using member sign-in, then edit the provider again", async ({ world, user, probe, step, evidence }) => {
  const read = async (path: string) => {
    const { response, body } = await probe.api(world.den.admin, path);
    expect(response.status, path).toBe(200);
    if (!isRecord(body)) throw new Error(`Expected a Den response object for ${path}.`);
    return body;
  };
  const readProvider = async () => {
    const { inferenceProvider } = await read(world.providerPath);
    if (!isRecord(inferenceProvider)) throw new Error("Expected provider details from Den.");
    return inferenceProvider;
  };
  const saveAndSeeList = async (name: string) => {
    await user.click({ testId: "gateway-provider-save" });
    const outcome = await probe.eventually(async () => ({
      route: new URL(await probe.url()),
      errors: (await probe.dom(ERROR_NOTICE)).elements.map((element) => element.text),
    }), {
      within: WITHIN,
      label: "the provider save finishes",
      until: ({ route, errors }) => errors.length > 0 || (route.pathname.endsWith("/dashboard/ai-gateway") && route.searchParams.get("tab") === "ai-providers"),
    });
    expect(outcome.errors).toEqual([]);
    await user.see({ text: name }, { timeoutMs: WITHIN });
    expect((await probe.dom(ERROR_NOTICE)).elements).toHaveLength(0);
  };
  const checkSaved = async (name: string, supportedIds: string[]) => {
    const provider = await readProvider();
    expect(provider).toMatchObject({ name, status: "active", modelIds: [] });
    const sets = records(provider.credentialSets);
    expect(sets).toHaveLength(1);
    expect(sets[0]).toMatchObject({ credentialMode: "member", oauthClientId: CLIENT_ID, hasOauthClientSecret: true });
    const grants = records(provider.accessGrants);
    expect(grants).toEqual([expect.objectContaining({ audience: { type: "organization" } })]);
    const groups = records(provider.modelGroups);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.modelIds).toEqual(expect.arrayContaining(supportedIds));
    expect(groups[0]?.modelIds).toHaveLength(supportedIds.length);
    const [group] = groups;
    const [set] = sets;
    const [grant] = grants;
    if (typeof group?.id !== "string" || typeof set?.id !== "string" || typeof grant?.id !== "string") throw new Error("Expected saved model group, credential set and grant IDs.");
    return { groupId: group.id, setId: set.id, grantId: grant.id, modelCount: supportedIds.length, status: provider.status };
  };

  await step("given a disabled Vertex provider with no credential set or access grants", async () => {
    await user.see({ text: VERTEX_PILOT_NAME }, { timeoutMs: WITHIN });
    await user.see({ testId: "gateway-provider-save" });
    const provider = await readProvider();
    expect(provider).toMatchObject({ name: VERTEX_PILOT_NAME, providerId: "google-vertex", status: "disabled", modelIds: [], credentialSets: [], accessGrants: [] });
    const setCount = records(provider.credentialSets).length;
    const grantCount = records(provider.accessGrants).length;
    evidence.recordAssertionEvidence("Vertex has not been shared yet", `Status: ${provider.status}; credential sets: ${setCount}; access grants: ${grantCount}.`, provider.status === "disabled" && setCount === 0 && grantCount === 0);
  });

  const supportedIds = modelIds(records((await read(`${world.providerPath}/available-models`)).models));
  await step("when the owner opens the picker, it lists Gemini and excludes unsupported models", async () => {
    await user.click({ testId: "gateway-models-pick" });
    await user.see({ testId: "gateway-models-count" }, { timeoutMs: WITHIN });
    const { provider: raw } = await read("/v1/llm-provider-catalog/google-vertex");
    if (!isRecord(raw) || typeof raw.npm !== "string") throw new Error("Expected Vertex's full catalog from Den.");
    const overrides = modelIds(records(raw.models).filter(({ config }) => isRecord(config) && isRecord(config.provider)
      && typeof config.provider.npm === "string" && config.provider.npm !== raw.npm));
    expect(overrides).not.toHaveLength(0);
    expect(supportedIds.some((id) => id.startsWith("gemini-"))).toBe(true);
    expect(supportedIds.filter((id) => overrides.includes(id))).toEqual([]);
    const testIdSelector = (ids: string[]) => ids.map((id) => `${PICKER_ROWS}[data-testid=${JSON.stringify(`gateway-model-${id}`)}]`).join(",");
    const rows = (await probe.dom(PICKER_ROWS)).elements.length;
    const supportedRows = (await probe.dom(testIdSelector(supportedIds))).elements.length;
    const overrideRows = (await probe.dom(testIdSelector(overrides))).elements.length;
    expect(rows).toBe(supportedIds.length);
    expect(supportedRows).toBe(rows);
    expect(overrideRows).toBe(0);
    evidence.recordAssertionEvidence("The picker lists only supported Vertex models", `${rows} supported models shown (including Gemini); ${overrides.length} unsupported SDK overrides in the catalog, ${overrideRows} shown.`, rows === supportedIds.length && supportedRows === rows && overrideRows === 0);
    await user.screenshot();
  });

  await step("when the owner selects member sign-in and shares all models with everyone", async () => {
    await user.click({ testId: "gateway-models-all" });
    await user.wheelAt({ x: 700, y: 420, deltaY: -1200 });
    await user.click({ role: "radio", name: "Shared API key" });
    await user.press("Tab");
    await user.press("Enter");
    await user.type({ testId: "gateway-oauth-client-id" }, CLIENT_ID);
    await user.type({ testId: "gateway-oauth-client-secret" }, "example-oauth-client-secret", { sensitive: true });
    await user.click({ role: "switch", name: "Everyone in the organization" });
    const allModels = (await probe.dom('[data-testid="gateway-models-all"]:checked')).elements.length === 1;
    const everyone = (await probe.dom('[role="switch"][aria-label="Everyone in the organization"][aria-checked="true"]')).elements.length === 1;
    expect(allModels && everyone).toBe(true);
    await user.see({ testId: "gateway-oauth-client-id" });
    evidence.recordAssertionEvidence("Member OAuth is offered without an extra feature flag", `OAuth client fields are shown; All models: ${allModels}; Everyone in the organization: ${everyone}.`, allModels && everyone);
    await user.screenshot();
  });

  const saved = await step("after: saving activates Vertex with member OAuth and organization-wide access", async () => {
    await saveAndSeeList(VERTEX_PILOT_NAME);
    const state = await checkSaved(VERTEX_PILOT_NAME, supportedIds);
    evidence.recordAssertionEvidence("The first save returns to AI Providers and persists the configuration", `No error notice; status: ${state.status}; 1 member credential set with client ID ${CLIENT_ID} and a configured secret; 1 organization grant; all ${state.modelCount} supported models saved.`, state.status === "active" && state.modelCount > 0);
    await user.screenshot();
    return state;
  });

  await step("after: renaming the provider keeps every supported model and the original grant", async () => {
    await user.navigate(world.editorUrl);
    await user.see({ testId: "gateway-provider-title-rename" }, { timeoutMs: WITHIN });
    expect((await probe.dom('[data-testid="gateway-models-all"]:checked')).elements).toHaveLength(1);
    await user.click({ testId: "gateway-provider-title-rename" });
    await user.type({ testId: "gateway-provider-title-input" }, RENAMED, { replace: true });
    await user.press("Enter");
    await saveAndSeeList(RENAMED);
    const state = await checkSaved(RENAMED, supportedIds);
    expect(state).toEqual(saved);
    const sameConfiguration = state.groupId === saved.groupId && state.setId === saved.setId && state.grantId === saved.grantId;
    evidence.recordAssertionEvidence("A second save returns to AI Providers without a model-selection error", `Name: ${RENAMED}; no error notice; same model group, member credential set and organization grant; all ${state.modelCount} supported models retained.`, sameConfiguration);
    await user.screenshot();
  });
});
