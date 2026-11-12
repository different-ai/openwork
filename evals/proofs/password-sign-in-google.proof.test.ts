import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { passwordSignInGoogle } from "../worlds/password-sign-in-google.ts";

const test = spec.world(passwordSignInGoogle, {
  resources: { surfaces: ["web"], services: ["den"] },
  timeout: 900_000,
});

test("a password member can choose Google without losing password sign-in", async ({ world, user, probe, step, evidence }) => {
  const member = user.on(world.web);

  await step("before: with the rollout off a fresh browser offers only the password and its reset link", async () => {
    await member.see({ role: "textbox", label: /^email$/i }, { timeoutMs: 60_000 });
    await member.type({ role: "textbox", label: /^email$/i }, world.account.email);
    await member.click({ role: "button", label: "Next" });
    await member.see({ role: "textbox", label: /^password$/i });
    await member.see({ role: "button", label: "Forgot password?" });
    await member.notSee({ role: "button", label: "Continue with Google" });
    const passwords = await probe.on(world.web).dom('input[name="password"]');
    evidence.recordAssertionEvidence("Default-off preserves password-only sign-in", `Password fields=${passwords.elements.length}; Google is absent`, passwords.elements.length === 1);
    await member.screenshot();
  });

  await step("after: enabling the rollout offers Google below the unchanged password form", async () => {
    await world.rollout(true);
    await member.reload();
    await member.see({ role: "textbox", label: /^email$/i }, { timeoutMs: 60_000 });
    await member.type({ role: "textbox", label: /^email$/i }, world.account.email);
    await member.click({ role: "button", label: "Next" });
    await member.see({ role: "textbox", label: /^password$/i });
    await member.see({ role: "button", label: "Sign in" });
    await member.see({ role: "button", label: "Forgot password?" });
    await member.see({ role: "button", label: "Continue with Google" });
    const passwords = await probe.on(world.web).dom('input[name="password"]');
    evidence.recordAssertionEvidence("Google is an alternative, not a replacement", `Password fields=${passwords.elements.length}; Sign in, Forgot password and Google are visible together`, passwords.elements.length === 1);
    await member.screenshot();
  });

  await step("after: the same choice fits a narrow browser without hiding password recovery", async () => {
    const mobile = user.on(world.mobile);
    await mobile.see({ role: "textbox", label: /^email$/i }, { timeoutMs: 60_000 });
    await mobile.type({ role: "textbox", label: /^email$/i }, world.account.email);
    await mobile.click({ role: "button", label: "Next" });
    await mobile.see({ role: "textbox", label: /^password$/i });
    await mobile.see({ role: "button", label: "Forgot password?" });
    await mobile.see({ role: "button", label: "Continue with Google" });
    const passwords = await probe.on(world.mobile).dom('input[name="password"]');
    evidence.recordAssertionEvidence("Both choices remain available at 390 pixels", `Password fields=${passwords.elements.length}; Forgot password and Google are visible`, passwords.elements.length === 1);
    await mobile.screenshot();
  });

  await step("choosing Google sends the entered email as a hint through the real sign-in request", async () => {
    await user.on(world.mobile).click({ role: "button", label: "Continue with Google" });
    const requests = await probe.eventually(() => world.socialRequests(), {
      within: 15_000,
      until: (requests) => requests.length > 0,
      label: "the browser starts Google sign-in",
    });
    expect(requests).toEqual([{ provider: "google", loginHint: world.account.email }]);
    const hinted = requests[0]?.provider === "google" && requests[0]?.loginHint === world.account.email;
    evidence.recordAssertionEvidence("The new button starts Google with the intended email hint", JSON.stringify(requests), hinted);
    // This proves the outgoing request, not an external Google callback.
  });

  await step("the member still signs into the original workspace with their password", async () => {
    await member.type({ role: "textbox", label: /^password$/i }, world.account.password, { sensitive: true });
    await member.click({ role: "button", label: "Sign in" });
    await member.see({ testId: "workspace-switcher-trigger" }, { timeoutMs: 60_000 });
    const workspace = await probe.on(world.web).dom('[data-testid="workspace-switcher-trigger"]');
    evidence.recordAssertionEvidence("Existing password authentication still works", `Signed-in workspace switcher count=${workspace.elements.length}`, workspace.elements.length === 1);
    await member.screenshot();
  });

  await step("turning off everywhere restores password-only on the next lookup", async () => {
    await world.rollout(true, true);
    const mobile = user.on(world.mobile);
    await mobile.navigate(world.den.ref.webUrl);
    await mobile.see({ role: "textbox", label: /^email$/i }, { timeoutMs: 60_000 });
    await mobile.type({ role: "textbox", label: /^email$/i }, world.account.email);
    await mobile.click({ role: "button", label: "Next" });
    await mobile.see({ role: "textbox", label: /^password$/i });
    await mobile.notSee({ role: "button", label: "Continue with Google" });
    const passwords = await probe.on(world.mobile).dom('input[name="password"]');
    evidence.recordAssertionEvidence("The kill switch removes only the new alternative", `Password fields=${passwords.elements.length}; Google is absent after a new lookup`, passwords.elements.length === 1);
    await mobile.screenshot();
  });
});
