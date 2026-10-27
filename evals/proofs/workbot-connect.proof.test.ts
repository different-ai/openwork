import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotConnect } from "../worlds/workbot-connect.ts";

const test = spec.world(workbotConnect, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: ["den"] } });

test("a member connects Drive from Documents without a dashboard detour or a false success", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("an unverified account offers connection settings instead of promising Connect works here", async () => {
    await user.navigate(`${world.url}documents?catalog=legacy`);
    await user.see({ text: "Couldn't verify an account to connect here." });
    await user.see({ role: "link", label: "Open connection settings" });
    await user.notSee({ role: "button", label: "Connect Google Drive" });
    await user.notSee({ role: "link", label: "Connect Google Drive" });
    evidence.recordAssertionEvidence("Missing provider hints do not invent an actionable account or a grant failure", `connection starts=${world.starts()}; token exchanges=${world.exchanges()}`, world.starts() === 0 && world.exchanges() === 0);
    await user.screenshot();
    await user.navigate(`${world.url}documents`);
  });
  await step("before: Documents needs the member's account", async () => {
    await user.see({ role: "button", label: "Connect Google Drive" });
    await user.notSee({ role: "button", label: /^Project brief\.txt$/, nth: 0 });
    evidence.recordAssertionEvidence("No document appears before consent", `ready=${await world.ready()}; starts=${world.starts()}`, !await world.ready() && world.starts() === 0);
    await user.screenshot();
  });
  await step("Calendar opens consent for the same assigned account and preserves the calendar view", async () => {
    await user.navigate(`${world.url}calendar`);
    await user.see({ role: "button", label: "Connect Google Calendar" });
    await user.click({ role: "button", label: "Connect Google Calendar" });
    const consent = await probe.eventually(() => world.consent(), { within: 10_000, label: "Calendar opens provider consent", until: value => Boolean(value) });
    await user.on(consent).click({ role: "button", label: "Decline access" });
    await user.see({ text: "Connection wasn't completed. Try again, or ask an admin to review the app's permissions." });
    expect(await probe.url()).toContain("/calendar");
    evidence.recordAssertionEvidence("Calendar does not detour through a dashboard", `URL=${await probe.url()}; starts=${world.starts()}; token exchanges=${world.exchanges()}`, world.starts() === 1 && world.exchanges() === 0);
    await user.screenshot();
    await user.navigate(`${world.url}documents`);
  });
  await step("the member declines provider consent and stays unconnected", async () => {
    await user.click({ role: "button", label: "Connect Google Drive" });
    const consent = await probe.eventually(() => world.consent(), { within: 10_000, label: "provider consent opens directly", until: value => Boolean(value) });
    await user.on(consent).see({ role: "button", label: "Approve access" });
    await user.on(consent).screenshot();
    await user.on(consent).click({ role: "button", label: "Decline access" });
    await user.see({ text: "Connection wasn't completed. Try again, or ask an admin to review the app's permissions." });
    expect(await probe.url()).toContain("/documents");
    expect(await world.ready()).toBe(false);
    evidence.recordAssertionEvidence("Declining never claims Connected", `ready=${await world.ready()}; token exchanges=${world.exchanges()}`, !await world.ready() && world.exchanges() === 0);
    await user.screenshot();
  });
  await step("expired consent leaves an honest retry beside Documents", async () => {
    await user.click({ role: "button", label: "Connect Google Drive" });
    const consent = await probe.eventually(() => world.consent(), { within: 10_000, label: "provider consent opens again", until: value => Boolean(value) });
    await user.on(consent).click({ role: "button", label: "Use expired consent" });
    await user.see({ text: "Connection wasn't completed. Try again, or ask an admin to review the app's permissions." });
    expect(await world.ready()).toBe(false);
    evidence.recordAssertionEvidence("An expired provider code is not a connection", `ready=${await world.ready()}; token exchanges=${world.exchanges()}`, !await world.ready() && world.exchanges() === 1);
    await user.screenshot();
  });
  await step("incomplete permissions do not unlock Drive", async () => {
    await user.click({ role: "button", label: "Connect Google Drive" });
    const consent = await probe.eventually(() => world.consent(), { within: 10_000, label: "the member reviews provider permissions", until: value => Boolean(value) });
    await user.on(consent).click({ role: "button", label: "Grant incomplete access" });
    await user.see({ text: "Connection wasn't completed. Try again, or ask an admin to review the app's permissions." });
    await user.notSee({ role: "button", label: /^Project brief\.txt$/, nth: 0 });
    expect(await world.ready()).toBe(false);
    evidence.recordAssertionEvidence("The real readiness read rejects the partial grant", `ready=${await world.ready()}; token exchanges=${world.exchanges()}`, !await world.ready() && world.exchanges() === 2);
    await user.screenshot();
  });
  await step("a callback without an opener reports sign-in and returns to the same Documents view", async () => {
    await user.click({ role: "button", label: "Connect Google Drive" });
    const consent = await probe.eventually(() => world.consent(), { within: 10_000, label: "the provider opens consent", until: value => Boolean(value) });
    await user.on(consent).click({ role: "link", label: "Continue in a separate tab" });
    const standalone = await probe.eventually(() => world.consent(true), { within: 10_000, label: "provider consent opens without an opener", until: value => Boolean(value) });
    await user.on(standalone).resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await user.on(standalone).click({ role: "button", label: "Approve access" });
    await user.on(standalone).see({ role: "heading", label: "Signed in to Google Workspace" });
    await user.on(standalone).see({ text: "Return to Workbot to verify the connection." });
    await user.on(standalone).notSee({ text: "You're connected" });
    await user.on(standalone).notSee({ text: "You can close this window and return to OpenWork." });
    const desktopHeading = await probe.on(standalone).dom("main.workbot-callback h1");
    expect(desktopHeading.elements[0]?.rect.height).toBeLessThanOrEqual(28.1);
    await user.on(standalone).screenshot();
    await user.on(standalone).resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const mobileHeading = await probe.on(standalone).dom("main.workbot-callback h1");
    expect(mobileHeading.elements[0]?.rect.height).toBeLessThanOrEqual(56.1);
    expect(mobileHeading.documentWidth).toBeLessThanOrEqual(mobileHeading.viewportWidth);
    await user.on(standalone).screenshot();
    await user.on(standalone).resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await user.on(standalone).click({ role: "link", label: "Return to Workbot" });
    await user.on(standalone).see({ role: "button", label: /^Project brief\.txt$/, nth: 0 });
    const returned = await probe.on(standalone).url();
    expect(returned).toBe(`${world.url}documents`);
    evidence.recordAssertionEvidence("The real callback uses Workbot wording and an explicit same-tab return", `Returned to ${returned}; ready=${await world.ready()}; starts=${world.starts()}`, returned === `${world.url}documents` && await world.ready());
    await user.on(standalone).screenshot();
    // Continue in the Workbot tab the member just returned to; no app state or browser globals are changed.
    user = user.on(standalone);
    probe = probe.on(standalone);
  });
  await step("after: reconnecting with full access opens the real Drive list in place", async () => {
    await user.see({ role: "button", label: /^Project brief\.txt$/, nth: 0 });
    await user.notSee({ role: "button", label: "Connect Google Drive" });
    expect(await probe.url()).toContain("/documents");
    expect(await world.ready()).toBe(true);
    evidence.recordAssertionEvidence("Connected is confirmed by Den, without leaving Documents", `ready=${await world.ready()}; starts=${world.starts()}; token exchanges=${world.exchanges()}; URL=${await probe.url()}`, await world.ready() && world.starts() === 5 && world.exchanges() === 3);
    await user.screenshot();
  });
  await step("Welcome reports the same account as Connected only after the verified grant", async () => {
    await user.navigate(world.url);
    await user.see({ role: "button", label: "Get started" });
    await user.click({ role: "button", label: "Get started" });
    await user.see({ text: "You're all connected" });
    await user.see({ text: /^Connected$/ });
    evidence.recordAssertionEvidence("Welcome uses the verified connection rather than the popup result", `ready=${await world.ready()}; starts=${world.starts()}`, await world.ready() && world.starts() === 5);
    await user.screenshot();
  });
});
