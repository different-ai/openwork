import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { aiGatewayCatalogStates } from "../worlds/ai-gateway-catalog-states.ts";

const test = spec.world(aiGatewayCatalogStates, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

function providers(body: unknown): Array<Record<string, unknown>> {
  const list = body && typeof body === "object" && "inferenceProviders" in body ? body.inferenceProviders : [];
  return Array.isArray(list) ? list.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null) : [];
}

function accessAudiences(provider: Record<string, unknown> | undefined): Array<Record<string, unknown>> {
  const grants = Array.isArray(provider?.accessGrants) ? provider.accessGrants : [];
  return grants.flatMap((grant: unknown) => {
    if (!grant || typeof grant !== "object" || !("audience" in grant)) return [];
    const audience = grant.audience;
    return audience && typeof audience === "object" ? [Object.fromEntries(Object.entries(audience))] : [];
  });
}

test("an owner shares Anthropic models, can cancel removing a person's or team's access, and a teammate cannot administer it", async ({
  world, user, probe, step, evidence,
}) => {
  const owner = user.on(world.web);
  const teammate = user.on(world.memberWeb);
  const page = probe.on(world.web);
  const manageable = "/v1/inference-providers?scope=manageable";
  const confirmationClosed = async () => {
    await page.eventually(() => page.dom('[data-testid="confirm-dialog"]'), {
      within: 10_000, label: "the access confirmation has closed", until: (found) => found.elements.length === 0,
    });
    await owner.notSee({ testId: "confirm-dialog" });
  };

  await step("before: the owner opens AI Gateway and it is empty", async () => {
    await owner.see({ testId: "gateway-providers-empty" }, { timeoutMs: 90_000 });
    await owner.see({ text: "No providers yet" });
    const before = await probe.api(world.den.admin, manageable);
    evidence.recordAssertionEvidence("no providers yet", `GET ${manageable} → ${before.response.status}, ${providers(before.body).length} providers`, providers(before.body).length === 0);
    await owner.screenshot();
  });

  await step("the owner picks Anthropic from the catalog", async () => {
    await owner.click({ testId: "gateway-provider-create" });
    await owner.see({ role: "heading", label: "Add a provider" }, { timeoutMs: 30_000 });
    await owner.see({ text: "Start here" });
    await owner.see({ placeholder: "Filter by name" });
    await owner.notSee({ testId: "gateway-provider-pick-litellm" });
    const catalogRows = (await page.dom('[data-testid="gateway-provider-catalog"] a')).elements;
    evidence.recordAssertionEvidence("the owner can browse the catalog without enabling the preview", `${catalogRows.length} provider links; LiteLLM is absent while its preview is off.`, catalogRows.length > 0);
    await owner.screenshot();
    await owner.click({ testId: "gateway-provider-pick-anthropic" });
    await owner.see({ testId: "gateway-provider-title" }, { text: "Add Anthropic", timeoutMs: 30_000 });
    await owner.screenshot();
  });

  await step("after: one key, everyone, all models becomes a provider row shared with the whole org", async () => {
    await owner.type({ testId: "gateway-provider-api-key" }, "sk-ant-eval-not-a-real-key");
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ testId: "gateway-provider-open" }, { timeoutMs: 60_000 });
    await owner.see({ text: "Anthropic" });
    await owner.see({ testId: "gateway-provider-audience" }, { text: "Everyone" });
    await owner.see({ text: "Ready" });
    const after = await probe.api(world.den.admin, manageable);
    const saved = providers(after.body).find((entry) => entry.providerId === "anthropic");
    const grants = Array.isArray(saved?.accessGrants) ? saved.accessGrants : [];
    const orgWide = grants.some((grant) => JSON.stringify(grant).includes('"type":"organization"'));
    evidence.recordAssertionEvidence("provider saved with an org-wide grant and no secret in the response", `${grants.length} grant(s), organization audience: ${orgWide}; response contains the key: ${after.text.includes("sk-ant-eval")}`, orgWide && !after.text.includes("sk-ant-eval"));
    expect(orgWide).toBe(true);
    expect(after.text).not.toContain("sk-ant-eval");
    await owner.see({ role: "link", label: "Add a provider" });
    const rawIds = (await page.dom('[data-testid="gateway-provider-row"] .font-mono')).elements;
    expect(rawIds).toHaveLength(0);
    await owner.screenshot();
  });

  await step("the owner switches the org to only the models they provide", async () => {
    await owner.see({ testId: "gateway-model-policy-state" }, { text: "Any model" });
    await owner.click({ testId: "gateway-model-policy-open" });
    await owner.click({ testId: "gateway-model-access-managed" });
    await owner.click({ testId: "gateway-model-policy-save" });
    await owner.see({ testId: "gateway-model-policy-state" }, { text: "Only models you provide", timeoutMs: 30_000 });
    const policies = await probe.api(world.den.admin, "/v1/desktop-policies");
    const text = JSON.stringify(policies.body);
    evidence.recordAssertionEvidence("default desktop policy blocks personal providers", `GET /v1/desktop-policies → ${policies.response.status}; allowCustomProviders:false present: ${text.includes('"allowCustomProviders":false')}`, text.includes('"allowCustomProviders":false'));
    await owner.screenshot();
  });

  await step("the owner adds a person and a team using the same sized access controls", async () => {
    await owner.click({ role: "link", label: "Manage Anthropic" });
    await owner.see({ testId: "gateway-provider-title" }, { text: "Anthropic", timeoutMs: 60_000 });
    await owner.see({ testId: "gateway-models-all" });
    const buttons = (await page.dom('[data-testid="gateway-access-add-person"], [data-testid="gateway-access-add-team"]')).elements;
    expect(buttons).toHaveLength(2);
    expect(buttons.map((button) => button.rect.height)).toEqual([32, 32]);
    await owner.click({ testId: "gateway-access-add-person" });
    await owner.click({ role: "combobox", label: "Person" });
    await owner.click({ role: "option", label: /^Gateway Teammate/ });
    await owner.click({ testId: "gateway-access-add-team" });
    await owner.click({ role: "combobox", label: "Team" });
    await owner.click({ role: "option", label: new RegExp(`^${world.teamName}`) });
    await owner.see({ role: "button", label: "Remove access for Gateway Teammate" });
    await owner.see({ role: "button", label: `Remove access for ${world.teamName}` });
    await owner.notSee({ role: "button", label: "Revoke" });
    expect((await page.dom('[data-testid="gateway-access-row"]')).elements).toHaveLength(2);
    evidence.recordAssertionEvidence("person and team access use shared 32px controls", `Add person and Add team are ${buttons.map((button) => button.rect.height).join(" / ")}px; both audience rows offer Remove rather than Revoke.`, buttons.every((button) => button.rect.height === 32));
    await owner.screenshot();
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ role: "link", label: "Manage Anthropic" }, { timeoutMs: 60_000 });
    const saved = providers((await probe.api(world.den.admin, manageable)).body).find((entry) => entry.providerId === "anthropic");
    const audiences = accessAudiences(saved);
    expect(audiences.some((audience) => audience.type === "member" && audience.memberId === world.teammateId)).toBe(true);
    expect(audiences.some((audience) => audience.type === "team" && audience.teamId === world.teamId)).toBe(true);
    expect(audiences.some((audience) => audience.type === "organization")).toBe(false);
  });

  await step("removing a person's access names the risk and Cancel keeps the person and team", async () => {
    await owner.click({ role: "link", label: "Manage Anthropic" });
    await owner.see({ role: "button", label: "Remove access for Gateway Teammate" }, { timeoutMs: 60_000 });
    await owner.click({ role: "button", label: "Remove access for Gateway Teammate" });
    await owner.see({ testId: "confirm-dialog" }, { text: /^Remove access for Gateway Teammate\?\s/ });
    await owner.see({ text: "Gateway Teammate will lose this direct access to Anthropic when you save. Access granted another way stays unchanged. You can add them back." });
    await owner.see({ role: "button", label: "Remove access" });
    await owner.see({ testId: "confirm-dialog-cancel" });
    const dialog = (await page.dom('[data-testid="confirm-dialog"]')).elements;
    expect(dialog).toHaveLength(1);
    await owner.screenshot();
    await owner.click({ testId: "confirm-dialog-cancel" });
    await confirmationClosed();
    await owner.see({ role: "button", label: "Remove access for Gateway Teammate" });
    await owner.see({ role: "button", label: `Remove access for ${world.teamName}` });
    const saved = providers((await probe.api(world.den.admin, manageable)).body).find((entry) => entry.providerId === "anthropic");
    const audiences = accessAudiences(saved);
    expect(audiences).toHaveLength(2);
    evidence.recordAssertionEvidence("Cancel leaves both saved audiences intact", `${dialog.length} confirmation dialog; after Cancel, the person and team remain on screen and Den still has ${audiences.length} access grants.`, audiences.length === 2);
    await owner.screenshot();
  });

  await step("after: confirming a person's removal affects only that direct grant when saved", async () => {
    await owner.click({ role: "button", label: "Remove access for Gateway Teammate" });
    await owner.see({ testId: "confirm-dialog" });
    await owner.click({ role: "button", label: "Remove access" });
    await confirmationClosed();
    await owner.notSee({ role: "button", label: "Remove access for Gateway Teammate" });
    await owner.see({ role: "button", label: `Remove access for ${world.teamName}` });
    const beforeSave = accessAudiences(providers((await probe.api(world.den.admin, manageable)).body).find((entry) => entry.providerId === "anthropic"));
    expect(beforeSave).toHaveLength(2);
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ role: "link", label: "Manage Anthropic" }, { timeoutMs: 60_000 });
    const afterSave = accessAudiences(providers((await probe.api(world.den.admin, manageable)).body).find((entry) => entry.providerId === "anthropic"));
    expect(afterSave).toEqual([expect.objectContaining({ type: "team", teamId: world.teamId })]);
    const teammateProviders = providers((await probe.api(world.teammate, "/v1/inference-providers")).body);
    expect(teammateProviders.some((entry) => entry.providerId === "anthropic")).toBe(true);
    evidence.recordAssertionEvidence("removing one grant preserves independent team access", `Before Save: ${beforeSave.length} grants; after Save: ${afterSave.length} team grant; the teammate can still use Anthropic through that team.`, beforeSave.length === 2 && afterSave.length === 1 && teammateProviders.some((entry) => entry.providerId === "anthropic"));
    await owner.screenshot();
  });

  await step("removing the team also asks first and Cancel keeps its saved access", async () => {
    await owner.click({ role: "link", label: "Manage Anthropic" });
    await owner.see({ role: "button", label: `Remove access for ${world.teamName}` }, { timeoutMs: 60_000 });
    await owner.click({ role: "button", label: `Remove access for ${world.teamName}` });
    await owner.see({ testId: "confirm-dialog" }, { text: new RegExp(`^Remove access for ${world.teamName}\\?\\s`) });
    await owner.see({ text: `Members of ${world.teamName} will lose this direct access to Anthropic when you save. Access granted another way stays unchanged. You can add them back.` });
    await owner.screenshot();
    await owner.click({ testId: "confirm-dialog-cancel" });
    await confirmationClosed();
    await owner.see({ role: "button", label: `Remove access for ${world.teamName}` });
    const audiences = accessAudiences(providers((await probe.api(world.den.admin, manageable)).body).find((entry) => entry.providerId === "anthropic"));
    expect(audiences).toEqual([expect.objectContaining({ type: "team", teamId: world.teamId })]);
    evidence.recordAssertionEvidence("Cancel also preserves the team's access", `${audiences.length} saved team grant remains after cancelling the named team confirmation.`, audiences.length === 1 && audiences[0]?.teamId === world.teamId);
    await owner.screenshot();
  });

  await step("a teammate has no AI Gateway page and cannot list providers as an admin", async () => {
    await teammate.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
    await teammate.notSee({ role: "link", label: /AI Gateway/ });
    await teammate.navigate(`${world.den.ref.webUrl}/dashboard/ai-gateway?tab=ai-providers`);
    await teammate.notSee({ testId: "gateway-provider-create" }, { timeoutMs: 30_000 });
    const denied = await probe.api(world.teammate, manageable);
    evidence.recordAssertionEvidence("teammate is refused the admin list", `GET ${manageable} as teammate → ${denied.response.status}`, denied.response.status === 403);
    expect(denied.response.status).toBe(403);
    await teammate.screenshot();
  });
});

test("an owner can distinguish slow, failed and empty models, retry them, and a teammate still cannot open the editor", async ({
  world, user, probe, step, evidence,
}) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);

  await step("before: picking a provider with a slow model read keeps the model rows in place", async () => {
    await owner.see({ testId: "gateway-providers-empty" }, { timeoutMs: 90_000 });
    await owner.click({ role: "link", label: "Add a provider" });
    await owner.see({ testId: "gateway-provider-pick-anthropic" }, { timeoutMs: 30_000 });
    await owner.notSee({ testId: "gateway-provider-pick-litellm" });
    await world.catalogFaults.hold("models");
    await owner.click({ testId: "gateway-provider-pick-anthropic" });
    await owner.see({ testId: "gateway-models-pick" }, { timeoutMs: 30_000 });
    await owner.click({ testId: "gateway-models-pick" });
    await owner.see({ testId: "gateway-models-loading" });
    const held = await page.eventually(async () => (await world.catalogFaults.requests()).filter((request) => request.kind === "models" && request.mode === "hold" && !request.completed), {
      within: 10_000, label: "the authenticated model catalog response is held", until: (requests) => requests.length > 0,
    });
    const placeholders = (await page.dom('[data-testid="gateway-models-loading"]')).elements;
    expect(placeholders).toHaveLength(4);
    await owner.notSee({ testId: "gateway-models-empty" });
    await owner.notSee({ testId: "gateway-models-error" });
    evidence.recordAssertionEvidence("a slow model read is visibly loading, not empty", `${held.length} authenticated HTTP 200 model response(s) held; ${placeholders.length} model-shaped placeholders; no empty or error claim.`, held.length > 0 && placeholders.length === 4);
    await owner.screenshot();
    await world.catalogFaults.recover("models");
    await owner.see({ testId: "gateway-provider-title" }, { text: "Add Anthropic", timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-models-count" });
  });

  await step("a failed model catalog stops loading and offers Retry", async () => {
    await world.catalogFaults.fail("models");
    await owner.reload();
    await owner.see({ testId: "gateway-models-error" }, { text: /^Could not load this provider's models\. Existing configuration has not changed\.\s*Retry$/, timeoutMs: 30_000 });
    await owner.click({ testId: "gateway-models-pick" });
    await owner.see({ testId: "gateway-models-retry" });
    await owner.notSee({ testId: "gateway-models-loading" });
    await owner.notSee({ text: "Loading models…" });
    await owner.notSee({ testId: "gateway-models-empty" });
    const failed = (await world.catalogFaults.requests()).filter((request) => request.kind === "models" && request.completed && request.status === 503);
    evidence.recordAssertionEvidence("failed models never masquerade as endless loading", `${failed.length} model read(s) answered HTTP 503; Retry is available; no loading rows or empty-success claim.`, failed.length > 0);
    expect(failed.length).toBeGreaterThan(0);
    await owner.screenshot();
  });

  await step("after: a successful empty model catalog says no models are available and protects Save", async () => {
    await world.catalogFaults.empty("models");
    await owner.click({ testId: "gateway-models-retry" });
    await owner.see({ testId: "gateway-models-empty" }, { text: /^No models are available in this provider's catalog\.\s*Retry$/, timeoutMs: 30_000 });
    await owner.see({ testId: "gateway-models-count" }, { text: "0 of 0 selected" });
    await owner.notSee({ testId: "gateway-models-loading" });
    await owner.notSee({ testId: "gateway-models-error" });
    const disabled = (await page.dom('[data-testid="gateway-models-select-all"]:disabled, [data-testid="gateway-models-clear"]:disabled')).elements;
    expect(disabled).toHaveLength(2);
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ text: "No models are available in this provider's catalog. Retry the catalog before saving." });
    const empty = (await world.catalogFaults.requests()).filter((request) => request.kind === "models" && request.mode === "empty" && request.completed && request.status === 200);
    evidence.recordAssertionEvidence("empty success is actionable and cannot erase model choices", `${empty.length} HTTP 200 empty model response(s); 0 of 0 models; both bulk actions disabled; Save asks to retry instead of accepting an empty catalog.`, empty.length > 0 && disabled.length === 2);
    expect(empty.length).toBeGreaterThan(0);
    await owner.screenshot();
  });

  await step("after: Retry restores models and a nonmatching filter has its own honest empty result", async () => {
    await world.catalogFaults.recover("models");
    await owner.click({ testId: "gateway-models-retry" });
    const available = await page.eventually(async () => (await page.dom('[data-testid^="gateway-model-"]')).elements, {
      within: 30_000, label: "the restored model rows are available", until: (models) => models.length > 0,
    });
    await owner.see({ testId: "gateway-models-count" }, { timeoutMs: 30_000 });
    await owner.notSee({ testId: "gateway-models-empty" });
    expect(available.length).toBeGreaterThan(0);
    await owner.type({ placeholder: "Filter models" }, "no-model-has-this-name");
    await owner.see({ testId: "gateway-models-filter-empty" }, { text: "No models match that filter. Try another name." });
    await owner.notSee({ testId: "gateway-models-loading" });
    const matching = (await page.dom('[data-testid^="gateway-model-"]')).elements;
    expect(matching).toHaveLength(0);
    evidence.recordAssertionEvidence("a filter miss is not a missing or loading catalog", `${available.length} restored models before filtering; ${matching.length} matches after an unmatched name; the result directs the owner to try another name.`, available.length > 0 && matching.length === 0);
    await owner.screenshot();
  });

  await step("the recovered provider can be saved normally without exposing its key", async () => {
    await owner.click({ testId: "gateway-models-all" });
    await owner.type({ testId: "gateway-provider-api-key" }, "sk-ant-eval-recovery-not-real");
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ role: "link", label: "Manage Anthropic" }, { timeoutMs: 60_000 });
    const saved = await probe.api(world.den.admin, "/v1/inference-providers?scope=manageable");
    const provider = providers(saved.body).find((entry) => entry.providerId === "anthropic");
    expect(provider).toBeDefined();
    expect(saved.text).not.toContain("sk-ant-eval-recovery");
    evidence.recordAssertionEvidence("catalog recovery preserves the ordinary provider flow", `Manage Anthropic is visible; Den returned ${providers(saved.body).length} provider and no key material.`, Boolean(provider) && !saved.text.includes("sk-ant-eval-recovery"));
    // Capture only after navigation, when the credential input is no longer on screen.
    await owner.screenshot();
  });

  await step("a teammate cannot use the recovered editor or bypass its administration boundary", async () => {
    const teammate = user.on(world.memberWeb);
    await teammate.navigate(`${world.den.ref.webUrl}/dashboard/ai-gateway/providers/new?provider=anthropic`);
    await teammate.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
    await teammate.notSee({ testId: "gateway-provider-api-key" }, { timeoutMs: 30_000 });
    await teammate.notSee({ testId: "gateway-provider-save" });
    const denied = await probe.api(world.teammate, "/v1/inference-providers?scope=manageable");
    expect(denied.response.status).toBe(403);
    evidence.recordAssertionEvidence("catalog recovery does not give a teammate editing rights", `The teammate sees no credential form or Save; manageable providers remains HTTP ${denied.response.status}.`, denied.response.status === 403);
    await teammate.screenshot();
  });
});
