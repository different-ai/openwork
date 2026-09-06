import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { reauthPopup } from "../worlds/reauth-popup.ts";

const test = spec.world(reauthPopup, { timeout: 900_000 });

test("workspace SSO verifies through a real popup and safely recovers from interrupted sign-in", async ({ world, user, probe, evidence, step }) => {
  await step("validate and enable the real OIDC connection", async () => {
    await user.navigate(world.testUrl);
    await user.see({ role: "button", label: "Approve sign-in" }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: "Approve sign-in" });
    await user.see({ text: /authentication test finished/i }, { timeoutMs: 90_000 });
    await world.enable();
    evidence.recordAssertionEvidence("A signed OIDC authentication passes the configuration test before SSO is enabled", "The browser completed the provider approval and configuration callback, then the server enabled the tested connection.", true);
  });
  await user.navigate(new URL("/dashboard/org-settings", world.den.ref.webUrl).toString());
  await user.see({ role: "button", label: "Save settings" }, { timeoutMs: 90_000 });
  await world.ageSession();
  const changedName = `${world.originalName} updated`;
  await user.type({ role: "textbox", label: /^Name$/ }, changedName, { replace: true });
  await user.click({ role: "button", label: "Save settings" });
  await user.see({ role: "button", label: "Continue with SSO" });
  expect(await world.storedName()).toBe(world.originalName);
  const waiting = async () => {
    await user.see({ text: "Complete sign-in in the other window" });
    await user.notSee({ role: "button", label: "Continue with SSO" });
    await user.notSee({ role: "button", label: "Continue with Google" });
    const popup = await probe.eventually(() => world.popup(), { within: 60_000, label: "real identity-provider popup", until: (value) => value !== null });
    if (!popup) throw new Error("Expected SSO popup");
    await user.on(popup).see({ role: "button", label: "Approve sign-in" });
    expect(await world.popupCount()).toBe(1);
    return popup;
  };
  await step("blocked and closed windows preserve the pending change", async () => {
    await world.blockPopups(true);
    await user.click({ role: "button", label: "Continue with SSO" });
    await user.see({ text: /Allow popups for OpenWork/ });
    expect(await world.popupCount()).toBe(0);
    await world.blockPopups(false);
    await user.click({ role: "button", label: "Continue with SSO" });
    const popup = await waiting();
    await user.click({ role: "button", label: "Reopen sign-in" });
    expect(await world.popupCount()).toBe(1);
    await world.closePopup(popup);
    await user.see({ text: /closed before confirmation/ });
    await user.see({ role: "button", label: "Continue with SSO" });
    expect(await world.storedName()).toBe(world.originalName);
    evidence.recordAssertionEvidence("Blocked or closed popups restore retry without changing workspace settings or duplicating windows", "Zero windows when blocked; one during sign-in and after Reopen; closing restored the SSO button; persisted workspace name remained unchanged.", true);
  });
  await step("provider denial and unrelated messages do not apply the mutation", async () => {
    await user.click({ role: "button", label: "Continue with SSO" });
    const popup = await waiting();
    await world.sendCompletion("wrong-nonce");
    await world.sendCompletion("foreign-origin");
    await user.see({ text: "Complete sign-in in the other window" });
    expect(await world.storedName()).toBe(world.originalName);
    await user.on(popup).click({ role: "button", label: "Deny sign-in" });
    await user.see({ role: "button", label: "Continue with SSO" }, { timeoutMs: 60_000 });
    expect(await world.storedName()).toBe(world.originalName);
    popup.client.close();
    evidence.recordAssertionEvidence("Unrelated completion messages and provider denial cannot complete the pending workspace mutation", "Wrong nonce and foreign origin kept the waiting screen; provider denial restored retry; the stored name remained unchanged.", true);
  });
  await step("a completion signal without fresh authentication cannot save settings", async () => {
    await user.click({ role: "button", label: "Continue with SSO" });
    const popup = await waiting();
    await world.sendCompletion("stale");
    await user.see({ role: "button", label: "Continue with SSO" }, { timeoutMs: 30_000 });
    expect(await world.storedName()).toBe(world.originalName);
    expect(await world.popupCount()).toBe(0);
    popup.client.close();
    evidence.recordAssertionEvidence("A matching completion signal cannot bypass server-side fresh authentication", "The signal closed the popup, but the aged server session rejected the retried mutation and the security check reopened with the original workspace name unchanged.", true);
  });
  await step("Cancel closes the real popup and does not retry", async () => {
    await user.click({ role: "button", label: "Continue with SSO" });
    const popup = await waiting();
    const nonce = await probe.eval("document.querySelector('[data-reauth-nonce]').dataset.reauthNonce");
    if (typeof nonce !== "string") throw new Error("Expected the current dialog nonce");
    await user.click({ role: "button", label: "Cancel" });
    await world.sendCompletion("stale", nonce);
    expect(await probe.eval("document.querySelector('[role=dialog]') === null")).toBe(true);
    await probe.eventually(() => world.popupCount(), { within: 10_000, label: "cancel closes popup", until: (count) => count === 0 });
    expect(await world.storedName()).toBe(world.originalName);
    popup.client.close();
    evidence.recordAssertionEvidence("Cancelling the parent dialog closes the popup and discards the pending change", "The dialog and popup both closed and the original workspace name remained stored.", true);
  });
  await step("a different SSO identity cannot approve the original user’s change", async () => {
    await user.click({ role: "button", label: "Save settings" });
    await user.see({ role: "button", label: "Continue with SSO" });
    await user.click({ role: "button", label: "Continue with SSO" });
    const popup = await waiting();
    await user.on(popup).type({ role: "textbox", label: "Email" }, world.otherEmail, { replace: true });
    await user.on(popup).click({ role: "button", label: "Approve sign-in" });
    await user.see({ text: `Sign in as ${world.den.admin.email} to confirm this change.` }, { timeoutMs: 60_000 });
    expect(await world.storedName()).toBe(world.originalName);
    popup.client.close();
    evidence.recordAssertionEvidence("A different identity cannot approve the original user's pending change", "The IdP authenticated a second synthetic identity, but OpenWork required the original admin and the stored workspace name stayed unchanged.", true);
  });
  await step("successful SSO resumes and persists the pending settings change", async () => {
    await user.see({ role: "button", label: "Continue with SSO" });
    await user.click({ role: "button", label: "Continue with SSO" });
    const popup = await waiting();
    await user.screenshot();
    await user.on(popup).screenshot();
    await user.on(popup).click({ role: "button", label: "Approve sign-in" });
    await user.see({ text: "Workspace settings updated." }, { timeoutMs: 60_000 });
    expect(await probe.eval("document.querySelector('[role=dialog]') === null")).toBe(true);
    expect(await world.storedName()).toBe(changedName);
    await probe.eventually(() => world.popupCount(), { within: 10_000, label: "successful popup closes", until: (count) => count === 0 });
    await user.reload();
    await user.see({ role: "textbox", label: /^Name$/ }, { value: changedName, timeoutMs: 60_000 });
    await user.screenshot();
    popup.client.close();
    evidence.recordAssertionEvidence("Real OIDC verification closes both surfaces and resumes a server-validated settings mutation", "A session aged beyond 15 minutes could not save; signed-token approval refreshed authentication, showed completion, closed the popup/dialog, and persisted the new workspace name across reload.", true);
  });
});
