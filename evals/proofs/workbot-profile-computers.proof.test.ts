import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotProfileComputers } from "../worlds/workbot-profile-computers.ts";

const test = spec.world(workbotProfileComputers, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });
const profile = "[data-workbot-profile]";
const tabs = `${profile} [role="tab"]`;

test("a member finds the same computers in Workbot's profile on desktop and phone", async ({ world, user, probe, step, evidence }) => {
  const openProfile = async () => user.click({ role: "button", label: "Workbot: open profile" });
  const close = async () => {
    await user.press("Escape");
    await probe.eventually(() => probe.dom(profile), { within: 5000, until: dom => dom.elements.length === 0 });
  };
  await user.resizeViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
  await step("before: Computers lives outside the five-tab profile", async () => {
    await user.navigate(world.url);
    await user.see({ role: "button", label: "Devices" });
    await openProfile();
    await user.see({ role: "tab", label: "Tasks" });
    expect((await probe.dom(tabs)).elements).toHaveLength(5);
    await user.notSee({ role: "tab", label: "Computers" });
    evidence.recordAssertionEvidence("The disabled rollout preserves the existing entry", "Standalone Devices; five profile tabs; no Computers tab", (await probe.dom(tabs)).elements.length === 5);
    await user.screenshot();
    await close();
  });
  await step("after: the desktop profile has six matching tabs and the existing computer list", async () => {
    world.setAccess({ profileComputers: true });
    await user.reload();
    await openProfile();
    await user.click({ role: "tab", label: "Computers" });
    await user.see({ text: "Studio laptop" });
    await user.see({ text: "Workbot's computer" });
    await user.notSee({ role: "button", label: "Devices" });
    expect((await probe.dom(tabs)).elements).toHaveLength(6);
    const selected = (await probe.dom(`${tabs}[aria-label="Computers"][aria-selected="true"]`)).elements;
    expect(selected).toHaveLength(1);
    expect(world.reads().filter(read => read.endsWith("/devices"))).toEqual(["GET /v1/workbot/devices"]);
    evidence.recordAssertionEvidence("Computers reuses the inventory read without a standalone duplicate", "Six tabs, Computers selected, Studio laptop and Workbot's computer; one inventory GET", selected.length === 1);
    await user.screenshot();
  });
  await step("arrow keys, Home and End select and focus the same icon tabs", async () => {
    await user.press("ArrowRight");
    expect((await probe.dom(`${tabs}[aria-label="Identity"][aria-selected="true"]`)).elements[0]?.focused).toBe(true);
    await user.press("Home");
    expect((await probe.dom(`${tabs}[aria-label="Tasks"][aria-selected="true"]`)).elements[0]?.focused).toBe(true);
    await user.press("End");
    await user.press("ArrowLeft");
    const selected = (await probe.dom(`${tabs}[aria-label="Computers"][aria-selected="true"]`)).elements[0];
    expect(selected?.focused).toBe(true);
    evidence.recordAssertionEvidence("Keyboard navigation preserves focus and selection", "Computers → Identity → Tasks → Identity → Computers", selected?.focused === true);
    await user.screenshot();
    await close();
  });
  for (const width of [390, 320]) await step(`after: all six tabs fit a ${width}px phone without overflow`, async () => {
    await user.resizeViewport({ width, height: 844, deviceScaleFactor: 1 });
    await openProfile();
    await user.click({ role: "tab", label: "Computers" });
    await user.see({ text: "Studio laptop" });
    const layout = await probe.dom(tabs);
    expect(layout.elements).toHaveLength(6);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    for (const tab of layout.elements) {
      expect(tab.rect.width).toBeGreaterThanOrEqual(44);
      expect(tab.rect.height).toBeGreaterThanOrEqual(44);
      expect(tab.rect.left).toBeGreaterThanOrEqual(0);
      expect(tab.rect.right).toBeLessThanOrEqual(width);
    }
    evidence.recordAssertionEvidence("Six accessible touch targets fit the phone", `${width}px viewport; six tabs at least 44px wide and high; document ${layout.documentWidth}px`, layout.documentWidth <= width);
    await user.screenshot();
    await close();
  });
  await step("Open closes the sheet and uses the existing Workbot computer view", async () => {
    await openProfile();
    await user.click({ role: "tab", label: "Computers" });
    await user.click({ role: "button", label: "Open Workbot's browser: Workbot's computer" });
    await probe.eventually(() => probe.url(), { within: 5000, until: url => new URL(url).pathname === "/computer" || new URL(url).pathname === "/browser" });
    await probe.eventually(() => probe.dom(profile), { within: 5000, until: dom => dom.elements.length === 0 });
    const path = new URL(await probe.url()).pathname;
    evidence.recordAssertionEvidence("The original guarded Open action is still reachable", `Profile dismissed; existing ${path} view opened; fixture has no remote computer`, path === "/computer" || path === "/browser");
    await user.screenshot();
  });
  const inventoryStates: Array<"empty" | "error"> = ["empty", "error"];
  for (const state of inventoryStates) await step(`the existing ${state} inventory state remains readable in the profile`, async () => {
    world.setInventory(state);
    await user.navigate(world.url);
    await openProfile();
    await user.click({ role: "tab", label: "Computers" });
    await user.see({ text: state === "empty" ? "No computers yet" : "Couldn't load your computers" });
    if (state === "error") await user.see({ role: "button", label: "Try again" });
    const inventoryText = (await probe.dom("[data-workbot-devices]")).elements[0]?.text ?? "";
    const expected = state === "empty" ? "No computers yet" : "Couldn't load your computers";
    expect(inventoryText).toContain(expected);
    evidence.recordAssertionEvidence("The inventory keeps its existing recovery state", inventoryText, inventoryText.includes(expected));
    await user.screenshot();
    await close();
  });
  await step("without Devices access the profile makes no inventory request", async () => {
    world.setAccess({ devices: false });
    await user.reload();
    const before = world.reads().filter(read => read.endsWith("/devices")).length;
    await openProfile();
    await user.notSee({ role: "tab", label: "Computers" });
    const after = world.reads().filter(read => read.endsWith("/devices")).length;
    expect(after).toBe(before);
    evidence.recordAssertionEvidence("The new navigation does not grant access", `Computers absent; inventory reads ${before} → ${after}`, before === after);
    await user.screenshot();
    await close();
  });
  await step("turning off the move restores the standalone entry and existing device links", async () => {
    world.setAccess({ devices: true, profileComputers: false });
    world.setInventory("populated");
    await user.resizeViewport({ width: 1440, height: 960, deviceScaleFactor: 1 });
    await user.reload();
    await user.click({ role: "button", label: "Devices" });
    await user.see({ text: "Studio laptop" });
    expect(new URL(await probe.url()).pathname).toBe("/devices");
    evidence.recordAssertionEvidence("Rollback needs no inventory or route migration", `Standalone Devices opens ${new URL(await probe.url()).pathname}; Studio laptop remains`, new URL(await probe.url()).pathname === "/devices");
    await user.screenshot();
  });
});
