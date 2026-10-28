import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { passwordSocialSignIn } from "../worlds/password-social-sign-in.ts";

const test = spec.world(passwordSocialSignIn, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den"] },
});

test("a member with a password can choose social sign-in without losing password recovery", async ({ world, user, probe, step, evidence }) => {
  await step("a password account reaches its usual password form", async () => {
    await user.see({ role: "textbox", label: "Email" }, { timeoutMs: 90_000 });
    await user.type({ role: "textbox", label: "Email" }, world.person.email);
    await user.click({ role: "button", label: "Next" });
    await user.see({ role: "textbox", label: "Password" });
    await user.see({ role: "button", label: "Forgot password?" });
    evidence.recordAssertionEvidence("The account still defaults to password sign-in", "A seeded password account reaches the password form, with Sign in and Forgot password? available.", true);
  });

  await step("after: Google and GitHub are alternatives below the password form", async () => {
    await user.see({ role: "button", label: "Sign in with Google" });
    await user.see({ role: "button", label: "Sign in with GitHub" });
    evidence.recordAssertionEvidence("Both social sign-in alternatives are available", "Sign in with Google and Sign in with GitHub appear alongside the existing password form.", true);
    await user.screenshot();
  });

  for (const provider of ["Google", "GitHub"]) {
    await step(`${provider} can start without entering a password and failures leave recovery available`, async () => {
      // This isolated deployment intentionally has no OAuth credentials. The real
      // endpoint's refusal proves the button starts social auth, not form submit.
      await user.click({ role: "button", label: `Sign in with ${provider}` });
      await probe.eventually(() => world.socialRequests.at(-1), {
        within: 10_000, label: `${provider} social sign-in request`,
        until: (request) => request?.provider === provider.toLowerCase(),
      });
      const request = world.socialRequests.at(-1);
      expect(request).toMatchObject({ provider: provider.toLowerCase() });
      expect(request).not.toHaveProperty("password");
      expect(typeof request?.callbackURL).toBe("string");
      await user.see({ text: /provider.*not found/i });
      await user.see({ role: "textbox", label: "Password" });
      await user.see({ role: "button", label: "Forgot password?" });
      evidence.recordAssertionEvidence(`${provider} starts the real social-auth request`, `Observed POST /api/auth/sign-in/social with provider=${provider.toLowerCase()}, a callback URL, and no password; the unconfigured provider reports Provider not found and recovery remains available.`, true);
      await user.screenshot();
    });
  }

  await step("password recovery does not offer social buttons", async () => {
    await user.click({ role: "button", label: "Forgot password?" });
    await user.see({ role: "button", label: "Send reset link" });
    await user.notSee({ role: "button", label: "Sign in with Google" });
    await user.notSee({ role: "button", label: "Sign in with GitHub" });
    evidence.recordAssertionEvidence("Recovery stays a separate flow", "Send reset link appears without either social sign-in alternative.", true);
    await user.screenshot();
  });

  await step("a Google-only connection flow does not gain a GitHub option", async () => {
    await user.navigate(`${world.den.ref.webUrl}/connect/mcp?connectionId=connection_fixture&org=organization_fixture&name=Connection`);
    await user.see({ role: "textbox", label: "Email" }, { timeoutMs: 90_000 });
    await user.type({ role: "textbox", label: "Email" }, world.person.email);
    await user.click({ role: "button", label: "Next" });
    await user.see({ role: "textbox", label: "Password" });
    await user.see({ role: "button", label: "Sign in with Google" });
    await user.notSee({ role: "button", label: "Sign in with GitHub" });
    evidence.recordAssertionEvidence("The caller's provider restriction is preserved", "The Google-only connection flow offers Google on the password step but no GitHub button.", true);
    await user.screenshot();
  });

  await step("the member can still sign in with their existing password", async () => {
    await user.navigate(world.den.ref.webUrl);
    await user.see({ role: "textbox", label: "Email" }, { timeoutMs: 90_000 });
    await user.type({ role: "textbox", label: "Email" }, world.person.email, { replace: true });
    await user.click({ role: "button", label: "Next" });
    await user.type({ role: "textbox", label: "Password" }, world.person.password);
    await user.click({ role: "button", label: /^Sign in$/ });
    await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 30_000 });
    evidence.recordAssertionEvidence("The original password still authenticates", "The member reaches the signed-in organization sidebar using their unchanged password.", true);
    await user.screenshot();
  });
});
