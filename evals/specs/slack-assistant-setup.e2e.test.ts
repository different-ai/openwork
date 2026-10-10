import { expect } from "vitest";
import { spec, type Probe } from "@openwork/testkit";
import type { DenSession } from "@openwork/behaviors";
import { slackAssistantSetup } from "../worlds/slack-assistant-setup.ts";
import { isRecord } from "../worlds/library.ts";

const test = spec.world(slackAssistantSetup, {
  timeout: 900_000,
  resources: { surfaces: ["web"], services: ["den", "mock"] },
  needs: { placement: "local", commands: ["pnpm", "bun"], optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
});
const section = '[data-testid="slack-assistant-setup"]';
const secretSelector = '[data-testid="slack-assistant-signing-secret"]';
const secretField = { label: "Slack app signing secret" };
const invalidSecret = "tinyfixturekey";

async function readSetup(probe: Probe, owner: DenSession, path: string, orgId: string) {
  const result = await probe.api(owner, path, { headers: { "x-openwork-org-id": orgId } });
  if (!result.response.ok || !isRecord(result.body)) throw new Error(`Slack setup read failed: HTTP ${result.response.status}`);
  return result;
}

async function switchState(probe: Probe, name: string, checked: boolean, disabled = false) {
  const selector = `${section} [role="switch"][aria-label="${name}"][aria-checked="${checked}"]${disabled ? ":disabled" : ":not(:disabled)"}`;
  const snapshot = await probe.eventually(() => probe.dom(selector), {
    within: 15_000, label: `${name} reflects the saved state`, until: (state) => state.elements.length === 1,
  });
  expect(snapshot.elements).toHaveLength(1);
}

async function focused(probe: Probe, selector: string) {
  const snapshot = await probe.dom(selector);
  expect(snapshot.elements).toHaveLength(1);
  expect(snapshot.elements[0]?.focused).toBe(true);
}

test("an owner configures OpenWork in Slack with consistent controls while a teammate and an unflagged workspace stay blocked", async ({ world, user, probe, step, evidence }) => {
  const read = () => readSetup(probe, world.den.admin, world.connection.path, world.orgId);
  const saved = async (key: string, value: boolean | string | null) => probe.eventually(read, {
    within: 15_000, label: `${key} is saved in Den`, until: (result) => isRecord(result.body) && result.body[key] === value,
  });

  await step("before: without a signing secret, all three switches remain visible and locked", async () => {
    await user.see({ role: "heading", label: "OpenWork in Slack" }, { timeoutMs: 120_000 });
    await user.see(secretField, { editable: true, value: "" });
    await user.see({ placeholder: "Paste from Slack app settings" });
    for (const name of ["Enable @openwork in Slack", "Send replies privately during rollout", "Show progress while working"]) {
      await user.see({ role: "switch", label: name }, { editable: false });
      await switchState(probe, name, false, true);
    }
    expect((await probe.dom(`${section} input[type="checkbox"]`)).elements).toHaveLength(0);
    expect((await probe.dom(`${section} select:disabled`)).elements).toHaveLength(1);
    expect((await probe.dom(`${section} details[open]`)).elements).toHaveLength(0);
    await user.notSee({ label: "Allowed channel IDs" });
    await user.notSee({ label: "Requests per member per day" });
    const result = await read();
    expect(result.body).toMatchObject({ enabled: false, hasSigningSecret: false, eligible: true, rolloutEnabled: true, runnerAvailable: true, installed: false, model: null, modelManagedByOrganization: false });
    const requests = await world.runnerRequests();
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((request) => request.method === "GET" && request.path === "/v1/models" && request.faulted && request.status === 200)).toBe(true);
    evidence.recordAssertionEvidence("the owner sees three disabled switches, an empty masked secret field and closed rare controls", "Eligible connection; Slack rollout on; local runner catalog served; no saved secret or bot installation; all three switches off and disabled", true);
    await user.see({ testId: "slack-assistant-setup" });
    await user.screenshot();
  });

  await step("a short signing secret is rejected without enabling the assistant", async () => {
    // Sensitive typing requires a native password input and redacts the trace.
    // Never pass a secret to see(value), DOM text or assertion failure messages.
    await user.type(secretField, invalidSecret, { sensitive: true, replace: true, verify: true });
    await user.click({ role: "button", label: "Save secret" });
    await user.see({ role: "alert" });
    const result = await read();
    expect(result.body).toMatchObject({ hasSigningSecret: false, enabled: false });
    const masked = await probe.credentialInputState(secretSelector, invalidSecret);
    expect(masked).toMatchObject({ inputType: "password", inputExcludedFromCapture: true, inputContainsSecret: true, bodyContainsSecret: false, urlContainsSecret: false, storageContainsSecret: false });
    evidence.recordAssertionEvidence("invalid secret validation still prevents a saved or enabled assistant", "Den rejected a secret shorter than 16 characters; no credential saved; assistant still off; the retained draft is masked and excluded from capture", true);
    await user.see({ testId: "slack-assistant-setup" });
    await user.screenshot();
  });

  await step("after: the owner saves the masked secret with the keyboard and every setup switch becomes available", async () => {
    await user.type(secretField, world.signingSecret, { sensitive: true, replace: true, verify: true });
    await user.press("Tab");
    await focused(probe, `${section} button:not([role]):focus`);
    expect((await probe.dom(`${section} button:focus`)).elements[0]?.text).toBe("Save secret");
    await user.press("Enter");
    await saved("hasSigningSecret", true);
    await user.see({ placeholder: "Saved securely" }, { value: "" });
    await user.notSee({ role: "alert" });
    for (const name of ["Enable @openwork in Slack", "Send replies privately during rollout", "Show progress while working"]) {
      await switchState(probe, name, false);
    }
    const masked = await probe.credentialInputState(secretSelector, world.signingSecret);
    expect(masked).toMatchObject({ inputType: "password", autoComplete: "off", empty: true, inputExcludedFromCapture: true, inputContainsSecret: false, bodyContainsSecret: false, urlContainsSecret: false, historyContainsSecret: false, storageContainsSecret: false });
    const result = await read();
    expect(result.text.includes(world.signingSecret)).toBe(false);
    expect((await probe.dom(`${section} select:not(:disabled)`)).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("saving the secret clears the input and unlocks all three switches without exposing credentials", "Saved securely; password field empty; three off switches enabled; the model remains selectable; setup GET contains no signing secret", true);
    await user.see({ testId: "slack-assistant-setup" });
    await user.screenshot();
  });

  await step("the owner enables Slack, private rollout replies and progress with native keyboard controls", async () => {
    await user.click(secretField);
    await user.press("Shift+Tab");
    await focused(probe, `${section} [aria-label="Enable @openwork in Slack"]`);
    await user.press("Space");
    await saved("enabled", true);
    await switchState(probe, "Enable @openwork in Slack", true);
    await user.click(secretField);
    // The empty Save secret button is skipped. Pass Add to Slack without
    // activating it: this journey never performs external installation.
    await user.press("Tab");
    await focused(probe, `${section} button:focus`);
    expect((await probe.dom(`${section} button:focus`)).elements[0]?.text).toBe("Add to Slack");
    await user.press("Tab");
    await focused(probe, `${section} [aria-label="Send replies privately during rollout"]`);
    await user.press("Space");
    await saved("shadowMode", true);
    await switchState(probe, "Send replies privately during rollout", true);
    // Saving temporarily disables every switch. Re-enter the tab order instead
    // of assuming the browser retained focus on a newly disabled button.
    await user.click(secretField);
    await user.press("Tab");
    await user.press("Tab");
    await user.press("Tab");
    await focused(probe, `${section} [aria-label="Show progress while working"]`);
    await user.press("Enter");
    await saved("progressUpdates", true);
    await switchState(probe, "Show progress while working", true);
    const switches = (await probe.dom(`${section} [role="switch"]`)).elements;
    expect(switches).toHaveLength(3);
    const rightEdges = switches.map((control) => control.rect.right);
    expect(Math.max(...rightEdges) - Math.min(...rightEdges)).toBeLessThan(1);
    expect(switches.every((control) => control.rect.width === 40 && control.rect.height === 24)).toBe(true);
    expect((await read()).body).toMatchObject({ enabled: true, shadowMode: true, progressUpdates: true, installed: false });
    evidence.recordAssertionEvidence("the same compact switch works with Space and Enter and saves each setting independently", "Enable, private replies and progress read back true from Den; three 40×24 switches share the same trailing edge; Slack remains uninstalled", true);
    await user.see({ testId: "slack-assistant-setup" });
    await user.screenshot();
  });

  await step("a connection-specific model remains selectable and survives a reload", async () => {
    await user.click(secretField);
    for (let index = 0; index < 4; index += 1) await user.press("Tab");
    await focused(probe, `${section} select`);
    // Typeahead commits a closed native select in place on every platform (macOS
    // opens its menu for arrow keys); "S" moves to the next "Slack fixture …"
    // model. Wait for each save and re-acquire focus after its temporary busy lock.
    await user.press("S");
    await saved("model", world.models[0].id);
    await user.see({ label: "Model" }, { value: world.models[0].id, editable: true });
    await user.click(secretField);
    for (let index = 0; index < 4; index += 1) await user.press("Tab");
    await focused(probe, `${section} select`);
    await user.press("S");
    await saved("model", world.models[1].id);
    await user.reload();
    await user.see({ role: "heading", label: "OpenWork in Slack" }, { timeoutMs: 90_000 });
    await user.see({ label: "Model" }, { value: world.models[1].id, editable: true });
    const result = await read();
    expect(result.body).toMatchObject({ model: world.models[1].id, modelManagedByOrganization: false, defaultModel: world.models[0].id, enabled: true, shadowMode: true, progressUpdates: true });
    await user.see({ placeholder: "Saved securely" }, { value: "" });
    evidence.recordAssertionEvidence("the control repair preserves model selection and all saved switch states", "The owner selected Slack fixture review with arrow keys; reload keeps that model and all three on states, while the runner default remains Slack fixture default", true);
    await user.see({ testId: "slack-assistant-setup" });
    await user.screenshot();
  });

  await step("the owner opens rollout limits with the keyboard and saves channel and daily limits", async () => {
    await user.click({ testId: "slack-assistant-limits-toggle" });
    await focused(probe, '[data-testid="slack-assistant-limits-toggle"]');
    await user.see({ label: "Allowed channel IDs" }, { value: "" });
    await user.press("Space");
    await user.notSee({ label: "Allowed channel IDs" });
    await user.press("Enter");
    await user.see({ label: "Allowed channel IDs" }, { editable: true });
    expect((await probe.dom('[data-testid="slack-assistant-limits"][open]')).elements).toHaveLength(1);
    await user.type({ label: "Allowed channel IDs" }, "CSETUP1, GSETUP2", { replace: true, verify: true });
    await user.type({ label: "Requests per member per day" }, "42", { replace: true, verify: true });
    await user.press("ArrowUp");
    await user.see({ label: "Requests per member per day" }, { value: "43" });
    await user.click({ role: "button", label: "Save limits" });
    const result = await probe.eventually(read, {
      within: 15_000, label: "rollout limits are saved in Den", until: (response) => isRecord(response.body) && response.body.dailyLimit === 43,
    });
    expect(result.body).toMatchObject({ channelIds: ["CSETUP1", "GSETUP2"], dailyLimit: 43, enabled: true, shadowMode: true, progressUpdates: true, model: world.models[1].id });
    await user.see({ label: "Allowed channel IDs" }, { value: "CSETUP1, GSETUP2" });
    expect((await probe.dom('[data-testid="slack-assistant-limits"] input[type="number"][min="1"][max="1000"]')).elements).toHaveLength(1);
    expect((await probe.dom('[data-testid="slack-assistant-manifest"][open]')).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("limits stay behind a native keyboard disclosure and save without changing reply settings", "Space closes and Enter opens Rollout limits; CSETUP1 and GSETUP2 read back from Den; the native number spinner increments 42 to 43; all switches and the chosen model are retained", true);
    await user.see({ testId: "slack-assistant-limits" });
    await user.screenshot();
  });

  await step("the Slack app manifest remains a separate collapsed disclosure, not an installation action", async () => {
    await user.click({ testId: "slack-assistant-limits-toggle" });
    await user.notSee({ label: "Allowed channel IDs" });
    await user.press("Tab");
    await focused(probe, '[data-testid="slack-assistant-manifest-toggle"]');
    await user.press("Enter");
    const manifest = await probe.dom('[data-testid="slack-assistant-manifest"][open] pre');
    expect(manifest.elements).toHaveLength(1);
    expect(manifest.elements[0]?.text).toContain('"display_name": "openwork"');
    expect(manifest.elements[0]?.text.includes(world.signingSecret)).toBe(false);
    await user.see({ text: /Merge these settings into the Slack app registered for this connection/ });
    const result = await read();
    expect(result.body).toMatchObject({ installed: false, channelIds: ["CSETUP1", "GSETUP2"], dailyLimit: 43 });
    const requests = await world.runnerRequests();
    expect(requests.every((request) => request.method === "GET" && request.path === "/v1/models" && request.faulted && request.status === 200)).toBe(true);
    const log = await world.den.apiLog();
    expect(log.includes(world.signingSecret) || log.includes(invalidSecret)).toBe(false);
    expect(/slack-assistant\/install|\/v1\/integrations\/slack\//.test(log)).toBe(false);
    evidence.recordAssertionEvidence("the manifest opens with Enter while no task, OAuth installation or Slack message is sent", "Separate manifest disclosure open; limits collapsed; bot still uninstalled; runner received catalog GETs only; raw Den logs contain neither typed fixture secret nor Slack install/webhook calls", true);
    await user.see({ testId: "slack-assistant-manifest" });
    await user.screenshot();
  });

  await step("a teammate without connection permissions sees who can unlock the page and cannot manage Slack", async () => {
    const teammate = user.on(world.teammateWeb);
    const teammateProbe = probe.on(world.teammateWeb);
    await teammate.see({ testId: "admin-access-state" }, { text: /Ask an organization owner or admin for access/, timeoutMs: 90_000 });
    expect((await teammateProbe.dom('[data-testid="admin-access-state"][data-access-state="locked"]')).elements).toHaveLength(1);
    await teammate.notSee({ testId: "slack-assistant-setup" });
    await teammate.notSee(secretField);
    const context = await probe.api(world.teammate, "/v1/org", { headers: { "x-openwork-org-id": world.orgId } });
    const permissions = isRecord(context.body) && isRecord(context.body.currentMember) ? context.body.currentMember.permissions : null;
    expect(Array.isArray(permissions)).toBe(true);
    expect(Array.isArray(permissions) && permissions.includes("connections.manage")).toBe(false);
    const denied = await probe.api(world.teammate, world.connection.path, { headers: { "x-openwork-org-id": world.orgId } });
    expect(denied.response.status).toBe(403);
    expect((await read()).body).toMatchObject({ enabled: true, shadowMode: true, progressUpdates: true, dailyLimit: 43 });
    evidence.recordAssertionEvidence("the teammate's direct link is locked and Den denies settings access", "The locked page names the required permission and the owner/admin who can grant it; no setup fields; no connections.manage permission; settings GET returns 403; the owner's saved settings are unchanged", true);
    await teammate.screenshot();
  });

  await step("an unflagged owner still sees the disabled Enable switch and the platform-admin reason", async () => {
    const unflagged = user.on(world.unflaggedWeb);
    const unflaggedProbe = probe.on(world.unflaggedWeb);
    await unflagged.see({ role: "heading", label: "OpenWork in Slack" }, { timeoutMs: 90_000 });
    await unflagged.see({ text: "Ask a platform admin to enable Slack Assistant for this workspace in /admin." });
    await unflagged.see({ role: "switch", label: "Enable @openwork in Slack" }, { editable: false });
    await switchState(unflaggedProbe, "Enable @openwork in Slack", false, true);
    await unflagged.see({ placeholder: "Saved securely" }, { value: "" });
    const result = await readSetup(probe, world.unflaggedOwner, world.unflaggedConnection.path, world.unflaggedOrgId);
    expect(result.body).toMatchObject({ enabled: false, hasSigningSecret: true, eligible: true, rolloutEnabled: false, runnerAvailable: true, installed: false, progressUpdates: false, shadowMode: false, channelIds: [], dailyLimit: 100 });
    expect((await read()).body).toMatchObject({ enabled: true, dailyLimit: 43, channelIds: ["CSETUP1", "GSETUP2"] });
    evidence.recordAssertionEvidence("the Slack rollout lock remains visible even with valid setup credentials", "OFF workspace: eligible owner, saved secret and available runner, but rollout disabled; Enable is off and locked with a platform-admin reason; the ON workspace keeps its own saved limits", true);
    await unflagged.see({ testId: "slack-assistant-setup" });
    await unflagged.screenshot();
  });
});
