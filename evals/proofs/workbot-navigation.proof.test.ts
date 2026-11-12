import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { workbotCommandPalette } from "../worlds/workbot-command-palette.ts";
import { workbotBrowserLifecycle } from "../worlds/workbot-browser-lifecycle.ts";

const test = spec.world(workbotCommandPalette, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });
const browserTest = spec.world(workbotBrowserLifecycle, { timeout: 120_000, needs: { placement: "local" }, resources: { surfaces: [], services: [] } });
const desktop = "[data-workbot-desktop-navigation]";
const drawer = "[data-workbot-mobile-navigation]";
const profile = "[data-workbot-profile]";
const sideRows = '[aria-label="Side chats"] li button > span:first-child';
const titles = ["Budget review", "Launch plan", "Travel notes"];

test("a member navigates direct chats and supported workspace destinations on desktop and phone", async ({ world, user, probe, step, evidence }) => {
  const closed = async (selector: string) => probe.eventually(() => probe.dom(selector), { within: 3000, label: "the panel finishes closing", until: layout => layout.elements.length === 0 });
  const list = async (root: string) => {
    await user.see({ role: "button", label: /^Travel notes/ });
    const shown = (await probe.dom(`${root} ${sideRows}`)).elements.map(row => row.text);
    expect(shown).toEqual(titles);
    return shown.join(" → ");
  };
  const destinations = async (root: string) => {
    const labels = (await probe.dom(`${root} nav:first-of-type button`)).elements.map(row => row.text);
    for (const label of ["Calendar", "Tasks", "Apps"]) await user.see({ role: "button", label });
    await user.notSee({ role: "button", label: /^(Computer|Browser|Documents|Files)$/ });
    expect((await probe.dom(`${root} button[aria-label="Computer"]`)).elements).toHaveLength(0);
    return labels;
  };
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await user.navigate(world.url);
  await step("after: at 1440px Main chat and newest-first side chats are directly visible", async () => {
    await user.see({ role: "button", label: /^Main chat/, nth: 1 });
    await user.see({ text: "On it. The venue research is still running." });
    const order = await list(desktop);
    await destinations(desktop);
    expect((await probe.dom(`${desktop} nav[aria-label="Chats"] [aria-current="page"]`)).elements[0]?.text).toMatch(/^Main chat/);
    await user.notSee({ role: "button", label: "Open workspace navigation" });
    evidence.recordAssertionEvidence("Direct chats and only supported destinations are available by default", `Main chat; ${order}; Calendar, Tasks, Apps; no Computer`, order === titles.join(" → "));
    await user.screenshot();
  });
  await step("after: the same navigation fits a 1920px desktop", async () => {
    await user.resizeViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
    const order = await list(desktop);
    const layout = await probe.dom(desktop);
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    evidence.recordAssertionEvidence("Wide desktop keeps all chats visible without horizontal overflow", `${order}; document ${layout.documentWidth}px / viewport ${layout.viewportWidth}px`, layout.documentWidth <= layout.viewportWidth);
    await user.screenshot();
  });
  await step("a member selects a side chat and starts a separate new chat", async () => {
    await user.click({ role: "button", label: /^Budget review/ });
    expect(new URL(await probe.url()).searchParams.get("chat")).toBe("sidechatbudget00001");
    expect((await probe.dom(`${desktop} [aria-label="Side chats"] [aria-current="page"]`)).elements[0]?.text).toMatch(/^Budget review/);
    await user.screenshot();
    await user.click({ role: "button", label: "New side chat" });
    const created = new URL(await probe.url()).searchParams.get("chat");
    expect(created).toMatch(/^[a-z0-9]{16,40}$/);
    expect(created).not.toBe("sidechatbudget00001");
    evidence.recordAssertionEvidence("Selecting a chat highlights it and plus opens a new conversation", `Budget review selected; new chat ${created}`, created !== null && created !== "sidechatbudget00001");
    await user.click({ role: "button", label: /^Main chat/, nth: 1 });
  });
  await step("Calendar opens the existing calendar rather than an invented destination", async () => {
    await user.click({ role: "button", label: "Calendar" });
    await probe.eventually(() => probe.url(), { within: 5000, label: "Calendar opens", until: url => url.includes("/calendar") });
    await user.notSee({ role: "button", label: "Computer" });
    evidence.recordAssertionEvidence("Calendar uses the supported workspace page", await probe.url(), (await probe.url()).includes("/calendar"));
    await user.screenshot();
    await user.click({ role: "button", label: /^Main chat/, nth: 1 });
  });
  for (const phone of [false, true]) {
    if (phone) {
      await user.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
      await user.navigate(world.url);
      await step("after: the 390px phone starts with its navigation drawer closed", async () => {
        await user.see({ role: "button", label: "Open workspace navigation" });
        expect((await probe.dom(drawer)).elements).toHaveLength(0);
        expect((await probe.dom(desktop)).elements).toHaveLength(0);
        evidence.recordAssertionEvidence("Phone navigation is available without any rollout parameter", await probe.url(), new URL(await probe.url()).search === "");
        await user.screenshot();
      });
      await step("the phone drawer lists Tabs, side chats and bottom search; Escape returns to its trigger", async () => {
        await user.click({ role: "button", label: "Open workspace navigation" });
        await user.see({ text: "Tabs" });
        expect(await destinations(drawer)).toEqual(["Main chat", "Calendar", "Tasks", "Apps"]);
        const order = await list(drawer);
        await user.see({ label: "Search side chats" });
        const search = (await probe.dom(`${drawer} input[aria-label="Search side chats"]`)).elements[0];
        const lastChat = (await probe.dom(`${drawer} ${sideRows}`)).elements.at(-1);
        expect(search?.rect.top).toBeGreaterThan(lastChat?.rect.bottom ?? Infinity);
        evidence.recordAssertionEvidence("The default phone menu exposes real destinations and a bottom chat filter", `Main chat, Calendar, Tasks, Apps; ${order}; search below chats`, (search?.rect.top ?? 0) > (lastChat?.rect.bottom ?? Infinity));
        await user.screenshot();
        await user.press("Escape");
        await closed(drawer);
        expect((await probe.dom('[aria-label="Open workspace navigation"]')).elements[0]?.focused).toBe(true);
        await user.press("Enter");
        await user.see({ role: "button", label: "Close workspace navigation" });
        await user.press("Escape");
        await closed(drawer);
      });
    }
    for (const destination of ["Tasks", "Apps"]) await step(`${phone ? "phone" : "desktop"} ${destination} opens its real profile tab and Escape returns`, async () => {
      if (phone) await user.click({ role: "button", label: "Open workspace navigation" });
      await user.click({ role: "button", label: destination });
      if (phone) await closed(drawer);
      const tab = destination === "Tasks" ? "Tasks" : /^(Permissions|What I can use)$/;
      await user.see({ role: "tab", label: tab });
      // Profile tabs are icon-only; their accessible labels identify the selected tab.
      const label = destination === "Tasks" ? '[aria-label="Tasks"]' : ':is([aria-label="Permissions"], [aria-label="What I can use"])';
      const selected = (await probe.dom(`${profile} [role="tab"][aria-selected="true"]${label}`)).elements.length;
      expect(selected).toBe(1);
      await user.notSee({ role: "tab", label: /^(Computer|Browser)$/ });
      evidence.recordAssertionEvidence(`${destination} opens the existing profile, never Computer`, `Selected ${destination} profile tab; no Computer tab`, selected === 1);
      await user.screenshot();
      await user.press("Escape");
      await closed(profile);
      await user.see({ role: "textbox", label: "Message Workbot" });
    });
  }
});

browserTest("opening the browser temporarily compacts navigation instead of squeezing the conversation", async ({ world, user, probe, step, evidence }) => {
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  await user.navigate(`${world.url}?scenario=browser-lifecycle&browser=1&computer=1&sideChats=1`);
  await step("desktop starts with persistent chats, then the inline card opens the existing panel", async () => {
    await user.see({ role: "button", label: "Open preview" });
    expect((await probe.dom(desktop)).elements).toHaveLength(1);
    await user.click({ role: "button", label: "Open preview" });
    await user.see({ role: "button", label: "Close browser view" });
    await user.see({ role: "button", label: "Open workspace navigation" });
    const chat = await probe.eventually(() => probe.dom(".workbot-layout-main"), { within: 5000, label: "the browser's conversation keeps its comfortable width", until: layout => (layout.elements[0]?.rect.width ?? 0) >= 400 });
    const width = chat.elements[0]?.rect.width ?? 0;
    expect(width).toBeGreaterThanOrEqual(400);
    expect(width).toBeLessThanOrEqual(480);
    expect((await probe.dom(desktop)).elements).toHaveLength(0);
    expect((await probe.dom("[data-workbot-browser-panel]")).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("Opening the existing browser panel preserves a usable conversation", `${width}px conversation; navigation available through its drawer; one browser panel`, width >= 400 && width <= 480);
    await user.screenshot();
  });
  await step("closing the panel restores direct sidebar chats", async () => {
    await user.click({ role: "button", label: "Close browser view" });
    await probe.eventually(() => probe.dom(desktop), { within: 5000, label: "persistent navigation returns", until: layout => layout.elements.length === 1 });
    await user.notSee({ role: "button", label: "Open workspace navigation" });
    expect((await probe.dom("[data-workbot-browser-panel]")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Closing the browser restores desktop navigation", "One persistent sidebar and no browser panel", (await probe.dom(desktop)).elements.length === 1);
    await user.screenshot();
  });
});
