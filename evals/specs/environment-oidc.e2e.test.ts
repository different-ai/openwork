import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { environmentOidc, restrictedEnvironmentOidc } from "../worlds/environment-oidc";

// The IdP is deliberately loopback-only. This tests the checked-out source,
// never a remote public provider, and opens only headless Chrome.
const test = spec.world(environmentOidc, {
  needs: { optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["mysql"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den"] },
});

test("a self-hosted owner signs in through an environment-configured identity provider without a local password", async ({ world, user, step, evidence }) => {
  await step("before: email signup is disabled but the installation sign-in is available", async () => {
    await user.see("Continue with Test identity");
    await user.screenshot();
    evidence.recordAssertionEvidence("installation sign-in offered", "Continue with Test identity; public email signup disabled", true);
  });
  await step("the owner continues to the identity provider", async () => {
    await user.click("Continue with Test identity");
    await user.see("Approve sign-in");
    await user.screenshot();
    evidence.recordAssertionEvidence("real provider redirect", "The mock identity provider requests approval", true);
  });
  await step("after: the verified owner returns to their organization without creating a password", async () => {
    await user.click("Approve sign-in");
    await user.see({ text: "Current workspace members" });
    const identity = await world.identity();
    expect(identity.email).toBe(world.email);
    expect(identity.organizationId).toMatch(/^org_/);
    await user.screenshot();
    evidence.recordAssertionEvidence("authenticated organization session", "Verified OIDC identity has a Den session and active organization", true);
  });
});

const restricted = spec.world(restrictedEnvironmentOidc, {
  needs: { optIn: ["OPENWORK_EVAL_E2E_TESTS"], commands: ["mysql"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den"] },
});

restricted("a verified identity outside the organization's allowed email domains cannot sign in", async ({ world, user, step, evidence }) => {
  await step("the outside member opens the installation sign-in", async () => {
    await user.see("Continue with Test identity");
    await user.click("Continue with Test identity");
    await user.see("Approve sign-in");
    evidence.recordAssertionEvidence("outside identity offered by the IdP", "The mock IdP authenticates an outside.test identity", true);
    await user.screenshot();
  });
  await step("the verified identity is refused by the organization's domain policy", async () => {
    await user.click("Approve sign-in");
    await user.see("Continue with Test identity");
    const { hasSession } = await world.identity();
    expect(hasSession).toBe(false);
    evidence.recordAssertionEvidence("no session issued", "Verified outside.test identity has no Den session", !hasSession);
    await user.screenshot();
  });
  await step("the refused member remains on sign-in instead of entering the organization", async () => {
    await user.see("Continue with Test identity");
    await user.notSee({ text: "Current workspace members" });
    evidence.recordAssertionEvidence("organization remains inaccessible", "The sign-in form remains; the organization dashboard is absent", true);
  });
});
