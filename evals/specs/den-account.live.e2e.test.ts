import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { liveAccountBrowser, liveBrowserNeeds, liveSignupBrowser } from "../worlds/live-den-browser.ts";
import { recordField, verificationCode } from "../worlds/live-den-api.ts";

const signup = spec.world(liveSignupBrowser, { needs: liveBrowserNeeds, timeout: 240_000 });
const account = spec.world(liveAccountBrowser, { needs: liveBrowserNeeds, timeout: 240_000 });

signup(".live signup verifies delivered email before allowing workspace access", async ({ world, user, evidence }) => {
  const after = new Date().toISOString();
  await user.navigate(`${world.den.webUrl}/?mode=sign-up`);
  await user.type({ role: "textbox", label: "Email" }, world.inbox.email);
  await user.click({ role: "button", label: "Next" });
  await user.type({ role: "textbox", label: "Name" }, "Live Eval");
  await user.type({ role: "textbox", label: "Password" }, world.password);
  await user.click({ role: "button", label: "Sign up" });
  await user.see({ text: "Verification code" });
  await user.notSee({ testId: "den-org-sidebar" });
  const message = await world.mail(after, /openwork verification code/i);
  await user.type({ role: "textbox", label: "Verification code" }, verificationCode(message));
  await user.click({ role: "button", label: "Verify email" });
  await user.see({ text: /workspace/i });
  await user.notSee({ text: "Verification code" });
  const session = await world.authenticate();
  expect(session.email).toBe(world.inbox.email);
  const me = await world.request("/v1/me");
  expect(me.response.status).toBe(200);
  expect(recordField(me.body, "user")?.syntheticRunId).toBe(world.run);
  const denied = await world.request("/v1/admin/synthetic-accounts", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: world.inbox.email, runId: world.run }),
  });
  expect(denied.response.status).toBe(403);
  evidence.recordAssertionEvidence("Trusted synthetic identity", "The registered signup retains its run classification in the authenticated profile; the ordinary account cannot register synthetic identities.", true);
  await world.deleteAccount();
  evidence.recordAssertionEvidence("Owned account deletion", "Admin cleanup found only the fresh exact test email with no memberships/workers, deleted it, and verified its absence.", true);
  evidence.recordAssertionEvidence("Verified signup", "The UI required the delivered OTP before leaving verification; the same account then authenticated through Den.", true);
});

account(".live wrong password is rejected; sign-in survives reload and sign-out locks the dashboard", async ({ world, user, probe, evidence }) => {
  await user.navigate(`${world.den.webUrl}/?mode=sign-in`);
  await user.type({ role: "textbox", label: "Email" }, world.inbox.email);
  await user.click({ role: "button", label: "Next" });
  await user.type({ role: "textbox", label: "Password" }, `${world.password}-wrong`);
  await user.click({ role: "button", label: "Sign in" });
  await user.see({ text: /invalid email or password|invalid credentials/i });
  await user.notSee({ testId: "den-org-sidebar" });
  await user.type({ role: "textbox", label: "Password" }, world.password, { replace: true });
  await user.click({ role: "button", label: "Sign in" });
  await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 60_000 });
  await user.reload();
  await user.see({ testId: "den-org-sidebar" });
  await user.click({ testId: "workspace-switcher-trigger" });
  await user.click({ role: "button", label: "Sign out" });
  await user.navigate(`${world.den.webUrl}/dashboard`);
  await user.see({ role: "textbox", label: "Email" });
  await user.notSee({ testId: "den-org-sidebar" });
  expect(await probe.storage("openwork:web:auth-token")).toBeNull();
  evidence.recordAssertionEvidence("Authentication lifecycle", "Invalid credentials never reached the dashboard; valid login survived reload; signing out cleared the stored token and a direct dashboard visit required login.", true);
});

account(".live password recovery delivers a link and invalidates the old password", async ({ world, user, evidence }) => {
  await user.navigate(`${world.den.webUrl}/?mode=sign-in`);
  await user.type({ role: "textbox", label: "Email" }, world.inbox.email);
  await user.click({ role: "button", label: "Next" });
  await user.click({ role: "button", label: "Forgot password?" });
  const after = new Date().toISOString();
  await user.click({ role: "button", label: "Send reset link" });
  const mail = await world.mail(after, /reset.*password|password.*reset/i);
  const links = `${mail.text}\n${mail.html}`.match(/https:\/\/[^\s<>"']+/g) ?? [];
  const reset = links.map((link) => new URL(link.replaceAll("&amp;", "&"))).find((url) =>
    [new URL(world.den.webUrl).origin, new URL(world.den.apiUrl).origin].includes(url.origin)
      && url.pathname.includes("reset-password"));
  expect(reset, "A first-party password reset URL must be delivered").toBeDefined();
  if (!reset) throw new Error("No first-party reset URL");
  await user.navigate(reset.href);
  const oldPassword = world.password;
  const newPassword = `${oldPassword}Updated!`;
  await user.type({ role: "textbox", label: "New password" }, newPassword);
  await user.type({ role: "textbox", label: "Confirm password" }, newPassword);
  await user.click({ role: "button", label: "Reset password" });
  await user.see({ text: "Your password has been reset." });
  world.password = newPassword;
  await user.navigate(`${world.den.webUrl}/?mode=sign-in`);
  await user.type({ role: "textbox", label: "Email" }, world.inbox.email);
  await user.click({ role: "button", label: "Next" });
  await user.type({ role: "textbox", label: "Password" }, oldPassword);
  await user.click({ role: "button", label: "Sign in" });
  await user.see({ text: /invalid email or password|invalid credentials/i });
  await user.notSee({ testId: "den-org-sidebar" });
  await user.type({ role: "textbox", label: "Password" }, newPassword, { replace: true });
  await user.click({ role: "button", label: "Sign in" });
  await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 60_000 });
  evidence.recordAssertionEvidence("Password recovery", "A delivered first-party reset link changed the password; the old password was rejected and the new password reached the dashboard.", true);
});
