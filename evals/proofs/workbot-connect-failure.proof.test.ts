import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotConnect } from "../worlds/workbot-connect.ts";

const test = spec.world(workbotConnect, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: ["den"] } });

test("a member whose provider withholds access gets a safe Workbot callback and same-tab return", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await step("before: Documents needs the member's account", async () => {
    await user.see({ role: "button", label: "Connect Google Drive" });
    await user.notSee({ role: "button", label: /^Project brief\.txt$/, nth: 0 });
    evidence.recordAssertionEvidence("Drive stays locked before consent", `ready=${await world.ready()}; starts=${world.starts()}`, !await world.ready() && world.starts() === 0);
    await user.screenshot();
  });
  await step("the actual partial-grant callback gives a safe Workbot retry instead of provider prose", async () => {
    await user.click({ role: "button", label: "Connect Google Drive" });
    const consent = await probe.eventually(() => world.consent(), { within: 10_000, label: "the provider opens consent", until: value => Boolean(value) });
    await user.on(consent).click({ role: "link", label: "Continue in a separate tab" });
    const standalone = await probe.eventually(() => world.consent(true), { within: 10_000, label: "provider consent opens without an opener", until: value => Boolean(value) });
    user = user.on(standalone);
    probe = probe.on(standalone);
    await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
    await user.click({ role: "button", label: "Grant incomplete access" });
    await user.see({ role: "heading", label: "Connection not verified" });
    await user.see({ text: "Try Connect again in Workbot. If it still fails, ask an admin to review this app's permissions." });
    await user.see({ role: "link", label: "Return to Workbot" });
    await user.notSee({ text: "https://www.googleapis.com/auth" });
    await user.notSee({ text: "You're connected" });
    const desktopHeading = await probe.dom("main.workbot-callback h1");
    expect(desktopHeading.elements[0]?.rect.height).toBeLessThanOrEqual(28.1);
    evidence.recordAssertionEvidence("The callback does not claim a connection or show provider scope errors", `ready=${await world.ready()}; token exchanges=${world.exchanges()}`, !await world.ready() && world.exchanges() === 1);
    await user.screenshot();
    await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const mobileHeading = await probe.dom("main.workbot-callback h1");
    expect(mobileHeading.elements[0]?.rect.height).toBeLessThanOrEqual(56.1);
    expect(mobileHeading.documentWidth).toBeLessThanOrEqual(mobileHeading.viewportWidth);
    await user.screenshot();
    await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  });
  await step("after: Return to Workbot keeps Documents locked and offers a retry", async () => {
    await user.click({ role: "link", label: "Return to Workbot" });
    await user.see({ role: "button", label: "Connect Google Drive" });
    await user.notSee({ role: "button", label: /^Project brief\.txt$/, nth: 0 });
    expect(await probe.url()).toBe(`${world.url}documents`);
    expect(await world.ready()).toBe(false);
    evidence.recordAssertionEvidence("The same-tab return never unlocks an incomplete grant", `URL=${await probe.url()}; ready=${await world.ready()}`, !await world.ready());
    await user.screenshot();
  });
});
