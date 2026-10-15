import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { webSigninRedirect } from "../worlds/web-signin-redirect.ts";

const test = spec.world(webSigninRedirect, {
  timeout: 600_000,
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  resources: { surfaces: ["web"], services: ["den"] },
});

test("a gateway visitor signs in in one tab and returns to their bookmarked page", async ({ world, user, probe, step, evidence }) => {
  const visitor = user.on(world.app);
  const bookmark = `${world.origin}/automations?view=saved#bookmarked`;
  await step("before: the default-off gateway waits for a sign-in click", async () => {
    await visitor.navigate(bookmark);
    await visitor.see({ role: "button", label: "Sign in to OpenWork" }, { timeoutMs: 60_000 });
    expect((await world.state(world.app)).signedIn).toBe(false);
    evidence.recordAssertionEvidence("Default-off keeps the manual sign-in gate", "The gateway shows Sign in to OpenWork and stores no auth token.", true);
    await visitor.screenshot();
  });
  await step("after: an existing Den session signs in without a click or another tab", async () => {
    await world.rollout(true);
    await visitor.navigate(bookmark);
    const state = await probe.eventually(() => world.state(world.app), {
      within: 90_000, label: "same-tab sign-in and bookmark restoration",
      until: state => state.signedIn && state.href === bookmark && state.attempt === null,
    });
    expect(state.signedIn).toBe(true);
    expect(state.href).toBe(bookmark);
    expect(await world.pages(world.app)).toBe(1);
    expect(world.requests.some(request => request.path === "/api/den/v1/auth/desktop-handoff/exchange" && request.status === 200)).toBe(true);
    expect(world.requests.some(request => request.path === "/api/den/v1/me" && request.status === 200)).toBe(true);
    evidence.recordAssertionEvidence("Existing Den authentication returns to the bookmark in one tab", "A real handoff exchange returned HTTP 200; the gateway holds an auth token, restores the path/query/fragment, and has exactly one page.", true);
    await visitor.screenshot();
  });
  const fresh = await world.freshBrowser();
  const newcomer = user.on(fresh);
  await step("a failed callback stays recoverable instead of restarting sign-in", async () => {
    await newcomer.navigate(`${world.origin}/signin?error=access_denied`);
    await newcomer.see({ role: "button", label: "Sign in to OpenWork" }, { timeoutMs: 60_000 });
    await newcomer.reload();
    await newcomer.see({ role: "button", label: "Sign in to OpenWork" });
    expect((await world.state(fresh)).signedIn).toBe(false);
    expect(await world.pages(fresh)).toBe(1);
    evidence.recordAssertionEvidence("An error callback and its reload never auto-redirect", "The manual retry remains visible after reloading the callback; no auth token or second page was created.", true);
    await newcomer.screenshot();
  });
  await step("a visitor without a Den session can retry in the same tab", async () => {
    await newcomer.click({ role: "button", label: "Sign in to OpenWork" });
    await newcomer.see({ role: "textbox", label: "Email" }, { timeoutMs: 60_000 });
    expect(new URL((await world.state(fresh)).href).origin).toBe(new URL(world.den.ref.webUrl).origin);
    expect(await world.pages(fresh)).toBe(1);
    evidence.recordAssertionEvidence("Manual retry reaches Den sign-in in the existing tab", "Den displays its real email sign-in form and exactly one browser page remains open.", true);
    await newcomer.screenshot();
  });
  const unsigned = await world.freshBrowser();
  const member = user.on(unsigned);
  await step("a visitor with no Den session is sent straight to sign-in", async () => {
    await member.navigate(bookmark);
    await member.see({ role: "textbox", label: "Email" }, { timeoutMs: 60_000 });
    expect(new URL((await world.state(unsigned)).href).searchParams.get("mode")).toBe("sign-in");
    expect(await world.pages(unsigned)).toBe(1);
    evidence.recordAssertionEvidence("A signed-out Den visitor reaches sign-in without a gateway click", "Opening the bookmarked gateway page automatically reaches Den's email form in the only tab.", true);
    await member.screenshot();
  });
  await step("signing in returns the visitor to the bookmarked page in the same tab", async () => {
    await member.type({ role: "textbox", label: "Email" }, world.den.admin.email);
    await member.click({ role: "button", label: "Next" });
    await member.type({ label: "Password" }, world.den.admin.password);
    await member.click({ role: "button", label: "Sign in" });
    const state = await probe.eventually(() => world.state(unsigned), {
      within: 90_000, label: "password sign-in return",
      until: state => state.signedIn && state.href === bookmark && state.attempt === null,
    });
    expect(state.href).toBe(bookmark);
    expect(await world.pages(unsigned)).toBe(1);
    expect(world.browserErrors).toEqual([]);
    evidence.recordAssertionEvidence("Password sign-in completes the same-tab handoff", `Real Den password authentication returns to the original path/query/fragment with an auth token and one page; the loop guard is cleared after success. Uncaught browser exceptions: ${world.browserErrors.length}; failed network transports: ${world.failedRequests.length}.`, true);
    await member.screenshot();
  });
  const failedGrant = await world.freshBrowser();
  const recovering = user.on(failedGrant);
  await step("an invalid one-time code stays on the manual retry surface", async () => {
    const rejectedBefore = world.requests.filter(request => request.path === "/api/den/v1/auth/desktop-handoff/exchange" && request.status >= 400).length;
    await recovering.navigate(`${world.origin}/signin?grant=invalid-fixture-grant`);
    await probe.eventually(() => world.requests.filter(request => request.path === "/api/den/v1/auth/desktop-handoff/exchange" && request.status >= 400).length, {
      within: 30_000, label: "real grant exchange rejected", until: count => count > rejectedBefore,
    });
    await recovering.see({ role: "button", label: "Sign in to OpenWork" });
    expect((await world.state(failedGrant)).signedIn).toBe(false);
    evidence.recordAssertionEvidence("A rejected grant is never replaced by another automatic sign-in", "Den rejected the fixture grant and the gateway kept its manual retry button without storing an auth token.", true);
    await recovering.screenshot();
  });
  await step("turning off the rollout restores the manual gate for another visitor", async () => {
    await world.rollout(true, true);
    const disabled = await world.freshBrowser();
    await user.on(disabled).navigate(bookmark);
    await user.on(disabled).see({ role: "button", label: "Sign in to OpenWork" }, { timeoutMs: 60_000 });
    expect((await world.state(disabled)).signedIn).toBe(false);
    evidence.recordAssertionEvidence("The kill switch restores the original sign-in gate", "A fresh signed-out browser stays at the gateway with Sign in to OpenWork after the deployment rollout is killed.", true);
    await user.on(disabled).screenshot();
  });
  expect(world.errors).toEqual([]);
});
