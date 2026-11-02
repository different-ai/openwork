import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { customConnectorSetup } from "../worlds/custom-connector-discovery-checks.ts";

const test = spec.world(customConnectorSetup, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den"] },
});

test("an admin sees real server and sign-in checks before choosing a custom connector route", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.web);
  const observed = probe.on(world.web);
  const phase = async (id: string, status: string) => (await observed.dom(`[data-testid="connector-discovery-checks"] [data-testid="setup-check-${id}"][data-status="${status}"]`)).elements.length === 1;

  await step("by default a real 401 is a successful connection while the sign-in provider is still checking", async () => {
    await admin.navigate(world.setupUrl("held"));
    await admin.see({ testId: "connector-discovery-checks" }, { timeoutMs: 60_000 });
    await probe.eventually(() => world.heldRequests(), { within: 20_000, label: "the provider response is actually held", until: count => count > 0 });
    await admin.see({ text: "Reached the server. Sign-in is required." });
    const server = await phase("server", "done");
    const resource = await phase("resource", "done");
    const provider = await phase("provider", "running");
    const prematureSuccess = await phase("provider", "done");
    const http401 = (await observed.dom('[data-testid="connector-discovery-checks"] [aria-label="HTTP status 401"]')).elements.length;
    const http200 = (await observed.dom('[data-testid="connector-discovery-checks"] [aria-label="HTTP status 200"]')).elements.length;
    evidence.recordAssertionEvidence("The three rows reflect completed network work, not a timer", `server done=${server}; settings done=${resource}; provider running=${provider}; provider done=${prematureSuccess}; HTTP 401 receipts=${http401}; HTTP 200 receipts=${http200}; held responses=${world.heldRequests()}`, server && resource && provider && !prematureSuccess && http401 === 1 && http200 === 1);
    expect(server && resource && provider && !prematureSuccess && http401 === 1 && http200 === 1).toBe(true);
    await admin.screenshot();
  });

  await step("valid sign-in metadata completes detection and the admin can still use their own OAuth app", async () => {
    world.release();
    await admin.see({ text: "Detection complete" }, { timeoutMs: 30_000 });
    await admin.click({ testId: "connector-discovery-summary" });
    await admin.see({ text: "Done" });
    const provider = await phase("provider", "done");
    await admin.click({ role: "radio", label: "Use your own OAuth app" });
    await admin.see({ label: "Client ID" });
    await admin.see({ text: "Callback URL" });
    await admin.type({ label: "Client ID" }, "synthetic-toggle-client");
    await admin.type({ label: "Client secret" }, "synthetic-toggle-secret");
    await admin.click({ role: "radio", label: "Use OpenWork" });
    await admin.click({ role: "radio", label: "Use your own OAuth app" });
    await admin.see({ label: "Client ID" }, { value: "synthetic-toggle-client" });
    await admin.see({ label: "Client secret" }, { value: "synthetic-toggle-secret" });
    const signIns = world.signInRequests();
    evidence.recordAssertionEvidence("Detection did not lock the admin into its recommendation or sign anyone in", `provider verified=${provider}; authorization/registration/token requests=${signIns}`, provider && signIns === 0);
    expect(provider).toBe(true);
    expect(signIns).toBe(0);
    await admin.screenshot();
  });

  await step("advertised optional permissions are not all requested until the admin chooses access", async () => {
    await admin.click({ role: "button", label: "Connect" });
    await admin.see({ text: "Choose the permissions to request before connecting." });
    const checked = (await observed.dom('[data-testid="connector-permissions"] input:checked')).elements.length;
    const saved = await world.savedConnections();
    evidence.recordAssertionEvidence("An empty selection does not silently fall back to all advertised permissions", `selected permissions=${checked}; saved connections=${saved}; authorization requests=${world.signInRequests()}`, checked === 0 && saved === 0 && world.signInRequests() === 0);
    expect(checked).toBe(0);
    await admin.screenshot();
    await admin.click({ role: "checkbox", label: "Request read" });
  });

  await step("checking again sends the headers the admin entered without submitting an OAuth app", async () => {
    await admin.click({ role: "button", label: "Add header" });
    await admin.type({ label: "Header 1 name" }, "X-Example-Key");
    await admin.type({ label: "Header 1 value" }, "synthetic-review-header");
    await admin.click({ role: "button", label: "Check again" });
    await admin.see({ text: "Detection complete" }, { timeoutMs: 30_000 });
    await probe.eventually(() => world.headerRequests(), { within: 15_000, label: "retry forwarded the entered header", until: count => count > 0 });
    const requests = world.headerRequests();
    const signIns = world.signInRequests();
    evidence.recordAssertionEvidence("Retry used the draft header only for discovery", `MCP requests carrying the synthetic header=${requests}; authorization/registration/token requests=${signIns}`, requests > 0 && signIns === 0);
    expect(requests).toBeGreaterThan(0);
    expect(signIns).toBe(0);
    await admin.screenshot();
  });

  await step("checking a pre-registered server again preserves the admin's own OAuth app draft", async () => {
    await admin.navigate(world.setupUrl("own"));
    await admin.see({ text: "Detection complete" }, { timeoutMs: 30_000 });
    await admin.see({ label: "Client ID" });
    await admin.type({ label: "Client ID" }, "synthetic-review-client");
    await admin.type({ label: "Client secret" }, "synthetic-review-secret");
    await admin.click({ testId: "connector-discovery-summary" });
    await admin.click({ role: "button", label: "Check again" });
    await admin.see({ text: "Detection complete" }, { timeoutMs: 30_000 });
    await admin.see({ label: "Client ID" }, { value: "synthetic-review-client" });
    await admin.see({ label: "Client secret" }, { value: "synthetic-review-secret" });
    const fields = (await observed.dom('[data-testid="setup-oauth-app"]')).elements.length;
    evidence.recordAssertionEvidence("Retry did not unmount or save the credential draft", `own-app form count=${fields}; authorization/registration/token requests=${world.signInRequests()}`, fields === 1 && world.signInRequests() === 0);
    expect(fields).toBe(1);
    expect(world.signInRequests()).toBe(0);
    await admin.screenshot();
  });

  await step("an incomplete manual address pair blocks Connect without saving or starting sign-in", async () => {
    await admin.click({ testId: "manual-oauth-summary" });
    await admin.type({ testId: "manual-oauth-authorization-endpoint" }, "https://auth.example.test/authorize");
    await admin.click({ role: "button", label: "Connect" });
    await admin.see({ text: /Enter both sign-in addresses/ });
    await admin.see({ testId: "connector-route" });
    await admin.see({ label: "Client ID" }, { value: "synthetic-review-client" });
    const saved = await world.savedConnections();
    evidence.recordAssertionEvidence("The visible validation error is enforced by the actual submit handler", `saved connections=${saved}; authorization/registration/token requests=${world.signInRequests()}`, saved === 0 && world.signInRequests() === 0);
    expect(saved).toBe(0);
    await admin.screenshot();
  });

  await step("conflicting scope advertisements require review and do not silently drop provider requirements", async () => {
    await admin.navigate(world.setupUrl("conflict"));
    await admin.see({ text: "Detection complete" }, { timeoutMs: 30_000 });
    await admin.click({ role: "button", label: "Connect" });
    await admin.see({ text: "Review the conflicting permission information before connecting." });
    const writeKept = (await observed.dom('[role="checkbox"][aria-label="Request write"][aria-checked="true"][data-disabled]')).elements.length === 1;
    const saved = await world.savedConnections();
    evidence.recordAssertionEvidence("The conflict is explicit rather than a false read-only promise", `required write scope retained=${writeKept}; saved connections=${saved}; authorization requests=${world.signInRequests()}`, writeKept && saved === 0 && world.signInRequests() === 0);
    expect(writeKept).toBe(true);
    await admin.screenshot();
  });

  await step("an HTTP 200 with an inconsistent issuer stays failed and offers another route", async () => {
    await admin.navigate(world.setupUrl("mismatch"));
    await admin.see({ text: "Sign-in information is inconsistent. Review the sign-in addresses below." }, { timeoutMs: 30_000 });
    const failed = await phase("provider", "failed");
    const green = await phase("provider", "done");
    await admin.see({ role: "radio", label: "Use your own OAuth app" });
    await admin.see({ role: "button", label: "Check again" });
    const signIns = world.signInRequests();
    const providerHttp200 = (await observed.dom('[data-testid="setup-check-provider"] [aria-label="HTTP status 200"]')).elements.length === 1;
    evidence.recordAssertionEvidence("HTTP success is not mistaken for verified sign-in metadata", `provider failed=${failed}; provider passed=${green}; provider HTTP 200=${providerHttp200}; authorization/registration/token requests=${signIns}`, failed && !green && providerHttp200 && signIns === 0);
    expect(failed && !green).toBe(true);
    expect(signIns).toBe(0);
    await admin.screenshot();
  });

  await step("reviewed issuer-mismatch addresses still need explicit confirmation before sign-in", async () => {
    await admin.type({ label: "Client ID" }, "synthetic-mismatch-client");
    await admin.type({ label: "Client secret" }, "synthetic-mismatch-secret");
    await admin.click({ role: "button", label: "Review published addresses" });
    await admin.see({ testId: "manual-oauth-trust-confirmation" });
    await admin.click({ role: "button", label: "Connect" });
    await admin.see({ text: /Confirm the sign-in destinations with the server owner/ });
    const confirmed = (await observed.dom('[data-testid="manual-oauth-trust-confirmation"] input:checked')).elements.length;
    const saved = await world.savedConnections();
    evidence.recordAssertionEvidence("Prefill is not consent and cannot save the inconsistent metadata by itself", `confirmation selected=${confirmed}; saved connections=${saved}; authorization/registration/token requests=${world.signInRequests()}`, confirmed === 0 && saved === 0 && world.signInRequests() === 0);
    expect(confirmed).toBe(0);
    expect(saved).toBe(0);
    await admin.screenshot();
  });
});
