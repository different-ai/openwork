import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { ssoSingleBrowser } from "../worlds/sso-browser.ts";

/** Require SSO lives on the Single sign-on tab of Auth & Security. */
const SSO_SETTINGS = "/dashboard/auth-security?tab=sso";

const single = spec.world(ssoSingleBrowser, { timeout: 600_000, needs: { placement: "local", commands: ["pnpm", "openssl"] }, resources: { surfaces: ["web"], services: ["den", "mock"] } });

single("a single-organization administrator does not receive the per-organization 409", async ({ world, user, probe, step, evidence }) => {
  await step("the administrator opens the deployment settings", async () => {
    await user.see({ text: "Single sign-on requirement" }, { timeoutMs: 90_000 });
    evidence.recordAssertionEvidence("single-organization settings are accessible", "password-created session; configured SAML; per-organization SSO generally available", new URL(await probe.url()).pathname === "/dashboard/auth-security");
    await user.screenshot();
  });
  await step("the single-organization requirement saves without per-org proof", async () => {
    await user.click({ role: "switch", label: "Require SSO for this organization" });
    await user.click({ role: "button", label: /^Save$/ });
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
