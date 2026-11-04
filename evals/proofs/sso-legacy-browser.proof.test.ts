import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { ssoLegacyBrowser, ssoSingleBrowser } from "../worlds/sso-browser.ts";

const legacy = spec.world(ssoLegacyBrowser, { timeout: 600_000, needs: { placement: "local", commands: ["pnpm", "openssl"] }, resources: { surfaces: ["web"], services: ["den", "mock"] } });
const single = spec.world(ssoSingleBrowser, { timeout: 600_000, needs: { placement: "local", commands: ["pnpm", "openssl"] }, resources: { surfaces: ["web"], services: ["den", "mock"] } });

legacy("with the rollout off, domain sign-in stays SSO-only and settings keep the legacy behavior", async ({ world, user, probe, step, evidence }) => {
  await step("the claimed domain offers SSO without a password alternative", async () => {
    await user.see({ role: "textbox", label: "Email" }, { timeoutMs: 90_000 });
    await user.type({ role: "textbox", label: "Email" }, world.owner.email);
    await user.click({ role: "button", label: "Next" });
    await user.see({ role: "button", label: /^Sign in with SSO$/ }, { timeoutMs: 30_000 });
    await user.notSee({ role: "button", label: "Use another sign-in method" });
    await user.screenshot();
    await user.click({ role: "button", label: /^Sign in with SSO$/ });
    await user.see({ role: "heading", label: "Synthetic organization sign-in" }, { timeoutMs: 30_000 });
    expect(new URL(await probe.url()).origin).toBe(world.idp.origin);
    evidence.recordAssertionEvidence("legacy domain sign-in goes directly to the SAML provider", "no ordinary password alternative; local IdP reached", new URL(await probe.url()).origin === world.idp.origin);
    await user.screenshot();
  });
  await step("a pre-existing password administrator changes the legacy setting without a new 409", async () => {
    const surface = await world.fresh("/dashboard/org-settings", world.den.admin);
    const admin = user.on(surface);
    const browser = probe.on(surface);
    const screen = await browser.eventually(() => browser.text(), { within: 90_000, label: "legacy settings or workspace choice", until: (value) => value.includes("Choose an organization") || value.includes("Single sign-on requirement") });
    if (screen.includes("Choose an organization")) {
      await admin.click({ role: "button", label: /Synthetic SSO organization/ });
      await browser.eventually(() => browser.text(), { within: 30_000, label: "workspace selected", until: (value) => !value.includes("Choose an organization") });
      await admin.navigate(`${world.den.ref.webUrl}/dashboard/org-settings`);
    }
    await admin.see({ text: "Single sign-on requirement" }, { timeoutMs: 90_000 });
    await admin.click({ role: "switch", label: "Require SSO for this organization" });
    await admin.click({ role: "button", label: "Save settings" });
    await admin.notSee({ text: "Sign in with this organization's SSO first" });
    const result = await probe.eventually(() => world.request(world.den.admin, "/v1/org", { headers: { "x-openwork-org-id": world.orgId } }), { within: 20_000, label: "legacy requirement saved", until: (value) => value.text.includes('\\"requireSso\\":true') || value.text.includes('"requireSso":true') });
    evidence.recordAssertionEvidence("the legacy setting saves without session provenance", `HTTP ${result.response.status}; requireSso=true`, result.response.ok);
    expect(result.response.ok).toBe(true);
    await admin.screenshot();
  });
  await step("the legacy browser completes the real signed SAML callback", async () => {
    const visitor = user.on(world.web);
    const browser = probe.on(world.web);
    await visitor.click({ role: "button", label: "Approve sign-in" });
    await browser.eventually(() => browser.text(), { within: 90_000, label: "legacy SAML returned to Den", until: (value) => value.includes("My Library") || value.includes("Choose an organization") });
    const session = await world.sessionFor(world.web);
    const opened = await world.request(session, "/v1/org", { headers: { "x-openwork-org-id": world.orgId } });
    evidence.recordAssertionEvidence("legacy SAML authentication remains usable", `HTTP ${opened.response.status}; signed responses=${world.idp.events.length}`, opened.response.ok && world.idp.events.length === 1);
    expect(opened.response.status).toBe(200);
    await visitor.screenshot();
  });
});

single("a single-organization administrator does not receive the per-organization 409", async ({ world, user, probe, step, evidence }) => {
  await step("the administrator opens the deployment settings", async () => {
    await user.see({ text: "Single sign-on requirement" }, { timeoutMs: 90_000 });
    evidence.recordAssertionEvidence("single-organization settings are accessible", "password-created session; configured SAML; rollout override present", new URL(await probe.url()).pathname === "/dashboard/org-settings");
    await user.screenshot();
  });
  await step("the single-organization requirement saves without per-org proof", async () => {
    await user.click({ role: "switch", label: "Require SSO for this organization" });
    await user.click({ role: "button", label: "Save settings" });
    const result = await probe.eventually(() => world.request(world.den.admin, "/v1/org", { headers: { "x-openwork-org-id": world.orgId } }), { within: 20_000, label: "single-org requirement saved", until: (value) => value.text.includes('\\"requireSso\\":true') || value.text.includes('"requireSso":true') });
    evidence.recordAssertionEvidence("single-org excludes the per-organization proof guard", `HTTP ${result.response.status}; requireSso=true`, result.response.ok);
    expect(result.response.ok).toBe(true);
    await user.screenshot();
  });
  await step("after reload the single-organization requirement remains saved", async () => {
    await user.reload();
    await user.see({ text: "Single sign-on requirement" }, { timeoutMs: 30_000 });
    const saved = await world.request(world.den.admin, "/v1/org", { headers: { "x-openwork-org-id": world.orgId } });
    const persisted = saved.text.includes('\\"requireSso\\":true') || saved.text.includes('"requireSso":true');
    evidence.recordAssertionEvidence("the single-org change is durable", `HTTP ${saved.response.status}; requireSso=${persisted}`, persisted);
    expect(persisted).toBe(true);
    await user.screenshot();
  });
});
