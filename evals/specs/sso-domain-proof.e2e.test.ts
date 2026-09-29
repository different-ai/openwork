import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { legacySsoDomainOwnership } from "../worlds/sso-domain-proof.ts";

const test = spec.world(legacySsoDomainOwnership, {
  resources: { surfaces: ["web"], services: ["den", "mock"] },
  needs: { placement: "local" },
  timeout: 600_000,
});

test("an owner requests domain ownership verification without disabling existing SSO", async ({ world, user, probe, step, evidence }) => {
  await step("before: existing SSO is enabled but email-domain ownership still needs verification", async () => {
    await user.navigate(new URL("/dashboard/sso", world.den.ref.webUrl).toString());
    await user.see({ text: "Domain ownership" }, { timeoutMs: 90_000 });
    await user.see({ text: "Verification needed" });
    await user.see({ text: "Enabled" });
    const state = await world.state();
    expect(state).toMatchObject({ status: "enabled", legacyVerified: true, emailDomainVerified: false, hasToken: false });
    evidence.recordAssertionEvidence("Existing sign-in eligibility is not presented as domain ownership", JSON.stringify(state), true);
    await user.screenshot();
  });

  await step("requesting a DNS token leaves existing sign-in enabled", async () => {
    await user.click({ role: "button", label: "Request token" });
    await user.see({ role: "button", label: "Verify domain" });
    const state = await probe.eventually(() => world.state(), {
      within: 15_000, label: "fresh DNS challenge", until: (value) => value.hasToken,
    });
    expect(state).toMatchObject({ status: "enabled", legacyVerified: true, emailDomainVerified: false, hasToken: true });
    evidence.recordAssertionEvidence("A fresh DNS challenge does not disable or replace SSO", JSON.stringify(state), true);
    await user.screenshot();
  });

  await step("after: missing DNS proof leaves verification pending and the token available for retry", async () => {
    // This isolated .test domain deliberately has no public DNS TXT record.
    await user.click({ role: "button", label: "Verify domain" });
    await user.see({ text: /Could not read the domain's DNS TXT record/ }, { timeoutMs: 60_000 });
    await user.see({ text: "Verification needed" });
    const state = await world.state();
    expect(state).toMatchObject({ status: "enabled", legacyVerified: true, emailDomainVerified: false, hasToken: true });
    evidence.recordAssertionEvidence("A failed DNS check never creates ownership proof", JSON.stringify(state), true);
    await user.screenshot();
  });
});
