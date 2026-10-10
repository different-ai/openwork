import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { browserConnectionFailureWorld } from "../worlds/browser-panel.ts";

const test = spec.world(browserConnectionFailureWorld, {
  resources: {
    surfaces: ["desktop"], services: [],
    nativeReason: "A real Electron WebContentsView must report a refused connection and stop covering the app's recovery controls.",
  },
});

test("a person sees why a site cannot connect and reloads the same tab when it returns", async ({ world, user, probe, step, evidence }) => {
  const address = { placeholder: "Enter URL..." };
  const error = { text: "This site refused the connection. Check that it is running, then reload." };

  await step("given an open browser tab and an unavailable local site", async () => {
    await user.see(address);
    const initial = await probe.eventually(() => probe.browserState(), {
      within: 15_000,
      until: state => state.nativeViews.some(view => view.tabId === world.tab.tabId && view.visible && view.attached),
      label: "the initial native browser page is visible",
    });
    evidence.recordAssertionEvidence("The browser starts with one visible tab", `1 native tab is visible; ${initial.tabs.length} tab is registered.`, initial.tabs.length === 1);
    expect(initial.tabs).toHaveLength(1);
    await user.screenshot();
    await user.type(address, world.failedUrl, { replace: true });
    await user.press("Enter");
  });

  await step("after: the unavailable site shows a connection error and Reload", async () => {
    await user.see(error, { timeoutMs: 15_000 });
    await user.see(address, { value: world.failedUrl });
    const failed = await probe.browserState();
    expect(failed.activeTabId).toBe(world.tab.tabId);
    expect(failed.nativeViews.find(view => view.tabId === world.tab.tabId)?.visible).toBe(false);
    await user.see({ role: "button", label: /^Reload$/ });
    await user.notSee({ text: "ERR_CONNECTION_REFUSED" });
    evidence.recordAssertionEvidence("The error and Reload replace the blank pane", "1 connection error and 1 Reload action are visible; 0 failed native views cover the recovery controls; the address is retained.", failed.nativeViews.every(view => view.tabId !== world.tab.tabId || !view.visible));
    await user.screenshot();
  });

  await step("then Technical details confirm the site refused the connection", async () => {
    await user.click({ role: "button", label: "Technical details" });
    await user.see({ text: /ERR_CONNECTION_REFUSED \(-102\)/ });
    evidence.recordAssertionEvidence("The unavailable site really refused a connection", "1 main-frame navigation reports Chromium ERR_CONNECTION_REFUSED with code -102 at the unchanged local address.", true);
    await user.screenshot();
    await user.click({ role: "button", label: "Technical details" });
    await user.see(address, { value: world.failedUrl });
  });

  await step("after: Reload opens the same address when the site returns", async () => {
    await world.restoreConnection();
    await user.click({ role: "button", label: /^Reload$/ });
    await user.on(world.page).see({ role: "heading", label: "Connection restored" }, { timeoutMs: 15_000 });
    await user.notSee(error, { timeoutMs: 15_000 });
    const recovered = await probe.eventually(() => probe.browserState(), {
      within: 15_000,
      until: state => state.nativeViews.some(view => view.tabId === world.tab.tabId && view.visible && view.attached),
      label: "successful navigation restores the native page",
    });
    const page = await probe.browserTabMetrics(world.tab.targetId);
    expect(recovered.activeTabId).toBe(world.tab.tabId);
    expect(recovered.tabs).toHaveLength(1);
    expect(page.url).toBe(world.failedUrl);
    evidence.recordAssertionEvidence("Reload recovers the original address and tab", "1 tab remains; the original tab and target are retained; its URL matches the failed address; 0 connection errors remain.", recovered.activeTabId === world.tab.tabId && recovered.tabs.length === 1 && page.url === world.failedUrl);
    // App-renderer CDP captures omit native WebContentsView pixels. Capture
    // the tab itself so the recovery frame shows the page the person sees.
    await user.on(world.page).screenshot();
  });
});
