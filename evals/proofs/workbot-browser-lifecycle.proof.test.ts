import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotBrowserLifecycle } from "../worlds/workbot-browser-lifecycle.ts";

const test = spec.world(workbotBrowserLifecycle, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });
// The repaired browser experience does not depend on any of the experimental
// profile/preview/working-status switches; every one is omitted (default false).
const flags = "browser=1&computer=1";

for (const viewport of [{ name: "phone", width: 390, height: 844 }, { name: "desktop", width: 1440, height: 1000 }]) {
  test(`a member on ${viewport.name} without browser access keeps the task record but cannot open its screen`, async ({ world, user, probe, step, evidence }) => {
    await user.resizeViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
    await step("a member without browser access sees an honest task record, never a live screen", async () => {
      await user.navigate(`${world.url}?scenario=browser-lifecycle`);
      await user.see({ text: "Open the project page in your browser" });
      await user.see({ text: "Browser access is off for your organization." });
      const disabled = (await probe.dom("[data-workbot-browser-card] button:disabled")).elements.length;
      const frames = (await probe.dom("[data-workbot-browser-card] canvas")).elements.length;
      const viewerRequests = (await world.requests()).filter(request => request.path.endsWith("/viewer")).length;
      expect(disabled).toBe(1);
      expect(frames).toBe(0);
      expect(viewerRequests).toBe(0);
      evidence.recordAssertionEvidence("Browser access is not granted by a stored task", `${disabled} disabled Open preview action; ${frames} frames; ${viewerRequests} viewer requests without browser access`, disabled === 1 && frames === 0 && viewerRequests === 0);
      await user.screenshot();
    });
  });
  test(`a member on ${viewport.name} keeps one browser task from working through completion and controls its preview`, async ({ world, user, probe, step, evidence }) => {
    await user.resizeViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
    await step("after: browser work has one blue Working card, not a Computer card or a connecting placeholder", async () => {
      await user.navigate(`${world.url}?scenario=google&${flags}`);
      await user.see({ role: "button", label: "Open preview" });
      await probe.eventually(() => probe.dom('[data-workbot-browser-card="working"] canvas'), { within: 8_000, until: result => result.elements.length === 1, label: "the working browser card has drawn its real stream frame" });
      const cards = await probe.dom("[data-workbot-browser-card]");
      expect(cards.elements.length).toBe(1);
      expect(cards.elements[0]?.text).toContain("Working");
      expect(cards.elements[0]?.text).not.toMatch(/Computer|Open computer|Connecting/);
      expect((await probe.dom("[data-workbot-browser-panel], [data-workbot-browser-sheet]")).elements.length).toBe(0);
      await world.keepCardIdentity();
      evidence.recordAssertionEvidence("One Working browser card", `${cards.elements.length} card with Working and the requested task; its actual DOM node is retained as the transition witness`, cards.elements.length === 1);
      await user.screenshot();
    });
    await step("after: the same card turns Completed and keeps the browser picture", async () => {
      await probe.eventually(() => probe.dom('[data-workbot-browser-card="completed"]'), { within: 15_000, until: result => result.elements.length === 1, label: "the stored browser result replaces working status" });
      await user.see({ text: "Done: google.com is open in my browser." });
      const same = await world.sameCard();
      const pictures = (await probe.dom('[data-workbot-browser-card="completed"] img')).elements.length;
      evidence.recordAssertionEvidence("Completion preserves the card rather than replacing it", `Same live DOM node: ${same}; retained browser pictures: ${pictures}; one Completed card`, same && pictures === 1);
      expect(same).toBe(true);
      expect(pictures).toBe(1);
      expect((await probe.dom("[data-workbot-browser-card]")).elements.length).toBe(1);
      await user.screenshot();
    });
    await step("after: reloading still shows the completed task, its picture and Open preview", async () => {
      await user.reload();
      await user.see({ role: "button", label: "Open preview" });
      const result = await probe.eventually(() => probe.dom('[data-workbot-browser-card="completed"] img'), { within: 10_000, until: value => value.elements.length === 1, label: "the completed browser picture survives reload" });
      expect((await probe.dom("[data-workbot-browser-card]")).elements.length).toBe(1);
      evidence.recordAssertionEvidence("The completed task survives a page reload", `${result.elements.length} retained image in one Completed browser card`, result.elements.length === 1);
      await user.screenshot();
    });
    await step(`after: Open preview opens ${viewport.name === "phone" ? "a full-screen phone dialog" : "the browser panel beside chat"} without navigating away`, async () => {
      const before = await probe.url();
      await user.click({ role: "button", label: "Open preview" });
      await user.see({ role: "button", label: "Close browser view" });
      const selector = viewport.name === "phone" ? "[data-workbot-browser-sheet]" : "[data-workbot-browser-panel]";
      const surface = await probe.eventually(() => probe.dom(selector), { within: 5_000, until: value => value.elements.length === 1, label: "the responsive browser preview is open" });
      const rect = surface.elements[0]?.rect;
      expect(rect).toBeDefined();
      if (viewport.name === "phone") {
        expect(rect?.width).toBe(viewport.width);
        expect(rect?.height).toBe(viewport.height);
        expect((await probe.dom('[role="dialog"]')).elements.length).toBe(1);
      } else {
        expect(rect?.width).toBeGreaterThan(600);
        expect(rect?.width).toBeLessThan(viewport.width);
        expect((await probe.dom('[role="dialog"]')).elements.length).toBe(0);
      }
      expect(await probe.url()).toBe(before);
      evidence.recordAssertionEvidence("Opening the browser does not replace the conversation", `${viewport.name}: ${rect?.width}×${rect?.height} ${viewport.name === "phone" ? "full-screen dialog" : "side panel"}; URL unchanged`, await probe.url() === before);
      await user.screenshot();
      await user.click({ role: "button", label: "Close browser view" });
    });
    await step("a live preview offers Stop task and Take control, then Hand back returns control to Workbot", async () => {
      await user.navigate(`${world.url}?scenario=browser-lifecycle&${flags}`);
      await user.see({ text: "Open the project page in your browser" });
      await user.see({ role: "button", label: "Open preview" });
      await user.click({ role: "button", label: "Open preview" });
      await user.see({ role: "button", label: "Stop task" });
      await user.see({ role: "button", label: "Take control" });
      await probe.eventually(() => probe.dom('[aria-label="Browser live view"] canvas'), { within: 10_000, until: result => result.elements.length === 1, label: "the full viewer has a frame before control is offered" });
      await user.screenshot();
      await user.click({ role: "button", label: "Take control" });
      await user.see({ role: "button", label: "Hand back" });
      await probe.eventually(async () => (await world.requests()).some(request => request.path.endsWith("/viewer") && typeof request.body === "object" && request.body !== null && "control" in request.body && request.body.control === true), { within: 5_000, until: value => value, label: "taking control asks the provider for a controlling viewer" });
      await user.screenshot();
      await user.click({ role: "button", label: "Close browser view" });
      await user.click({ role: "button", label: "Open preview" });
      await user.see({ role: "button", label: "Hand back" });
      const other = viewport.name === "phone" ? { width: 1440, height: 1000 } : { width: 390, height: 844 };
      await user.resizeViewport({ ...other, deviceScaleFactor: 1 });
      await probe.eventually(() => probe.dom(viewport.name === "phone" ? "[data-workbot-browser-panel]" : "[data-workbot-browser-sheet]"), { within: 5_000, until: result => result.elements.length === 1, label: "control survives moving to the other responsive surface" });
      await user.see({ role: "button", label: "Hand back" });
      await user.resizeViewport({ width: viewport.width, height: viewport.height, deviceScaleFactor: 1 });
      await probe.eventually(() => probe.dom(viewport.name === "phone" ? "[data-workbot-browser-sheet]" : "[data-workbot-browser-panel]"), { within: 5_000, until: result => result.elements.length === 1, label: "control survives returning to the original responsive surface" });
      await user.see({ role: "button", label: "Hand back" });
      await user.click({ role: "button", label: "Hand back" });
      await user.see({ role: "button", label: "Take control" });
      await user.click({ role: "button", label: "Stop task" });
      await user.see({ text: "Stopped before the browser task finished.", nth: 0 });
      expect((await probe.dom('[data-workbot-browser-card="failed"]')).elements.length).toBe(1);
      const requests = await world.requests();
      const handedBack = requests.some(request => request.path.endsWith("/action") && typeof request.body === "object" && request.body !== null && "action" in request.body && request.body.action === "continue");
      const stopped = requests.some(request => request.path === "/v1/workbot/stop");
      expect(handedBack).toBe(true);
      expect(stopped).toBe(true);
      evidence.recordAssertionEvidence("Toolbar controls reach their real provider routes", `Take control requested control:true; Hand back sent action:continue: ${handedBack}; Stop task posted /v1/workbot/stop: ${stopped}`, handedBack && stopped);
      await user.screenshot();
    });
  });
}
