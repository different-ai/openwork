import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { adminDashboardWeb } from "../worlds/den-admin-navigation.ts";

// The Den admin IA consolidates Collections, Desktop policies, and Brand
// appearance under one Manage > Advanced entry. Plugin Directory now owns
// Sources, while the legacy integrations URL redirects to that selected tab.
const test = spec.world(adminDashboardWeb, { timeout: 420_000 });

test("the Den admin sidebar exposes Advanced and moves Sources into Plugin Directory", async ({ world, user, probe, evidence }) => {
  await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
  const initialLabels = await probe.eventually(() => world.sidebarLinks(), {
    within: 30_000,
    label: "new top-level admin navigation",
    until: (labels) => labels.includes("Advanced") && labels.includes("Plugin Directory"),
  });
  const initialOk = initialLabels.includes("Advanced") && initialLabels.includes("Plugin Directory")
    && !initialLabels.includes("Collections") && !initialLabels.includes("Sources")
    && !initialLabels.includes("Brand appearance") && !initialLabels.includes("Desktop Policies");
  expect(initialOk).toBe(true);
  evidence.recordAssertionEvidence("The sidebar has Advanced and Plugin Directory without legacy top-level or Settings children", `Sidebar links: ${JSON.stringify(initialLabels)}`, initialOk);

  await user.click({ role: "link", label: "Advanced" });
  const advancedPath = await probe.eventually(() => world.location(), {
    within: 30_000, label: "Advanced route", until: (path) => path === "/dashboard/marketplaces",
  });
  await user.see({ text: "Advanced" }, { timeoutMs: 30_000 });
  const collectionsTabs = await probe.eventually(() => world.selectedTabs(), {
    within: 30_000, label: "Collections tab selected", until: (tabs) => tabs.length === 1 && tabs[0] === "Collections",
  });
  const advancedOk = advancedPath === "/dashboard/marketplaces" && collectionsTabs.length === 1 && collectionsTabs[0] === "Collections";
  expect(advancedOk).toBe(true);
  evidence.recordAssertionEvidence("Advanced opens Collections at /dashboard/marketplaces with no other tab selected", `path=${advancedPath}; selected=${JSON.stringify(collectionsTabs)}`, advancedOk);
  await user.screenshot();

  await user.click({ role: "tab", label: "Desktop policies" });
  const desktopPath = await probe.eventually(() => world.location(), {
    within: 30_000, label: "Desktop policies route", until: (path) => path === "/dashboard/desktop-policies",
  });
  const desktopTabs = await probe.eventually(() => world.selectedTabs(), {
    within: 30_000, label: "Desktop policies tab selected", until: (tabs) => tabs.length === 1 && tabs[0] === "Desktop policies",
  });
  const desktopLabels = await probe.eventually(() => world.sidebarLinks(), {
    within: 30_000, label: "single Advanced sidebar entry", until: (labels) => labels.includes("Advanced") && !labels.includes("Desktop Policies"),
  });
  const desktopOk = desktopPath === "/dashboard/desktop-policies" && desktopTabs[0] === "Desktop policies"
    && desktopLabels.includes("Advanced") && !desktopLabels.includes("Desktop Policies");
  expect(desktopOk).toBe(true);
  evidence.recordAssertionEvidence("Desktop policies is an Advanced tab, not a separate sidebar child", `path=${desktopPath}; selected=${JSON.stringify(desktopTabs)}; sidebar=${JSON.stringify(desktopLabels)}`, desktopOk);

  await user.click({ role: "tab", label: "Brand appearance" });
  const brandPath = await probe.eventually(() => world.location(), {
    within: 30_000, label: "Brand appearance route", until: (path) => path === "/dashboard/brand-appearance",
  });
  await user.see({ testId: "brand-appearance-screen" }, { timeoutMs: 30_000 });
  const brandTabs = await probe.eventually(() => world.selectedTabs(), {
    within: 30_000, label: "Brand appearance tab selected", until: (tabs) => tabs.length === 1 && tabs[0] === "Brand appearance",
  });
  const brandOk = brandPath === "/dashboard/brand-appearance" && brandTabs.length === 1 && brandTabs[0] === "Brand appearance";
  expect(brandOk).toBe(true);
  evidence.recordAssertionEvidence("Brand appearance is the only selected Advanced tab on its screen", `path=${brandPath}; selected=${JSON.stringify(brandTabs)}`, brandOk);

  await user.navigate(new URL("/dashboard/org-settings", world.den.ref.webUrl).toString());
  await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 30_000 });
  const settingsLabels = await probe.eventually(() => world.sidebarLinks(), {
    within: 30_000,
    label: "expanded Settings children",
    until: (labels) => labels.includes("General") && labels.includes("Billing"),
  });
  const settingsOk = settingsLabels.includes("General") && settingsLabels.includes("Billing")
    && !settingsLabels.includes("Brand appearance") && !settingsLabels.includes("Desktop Policies");
  expect(settingsOk).toBe(true);
  evidence.recordAssertionEvidence("Expanded Settings keeps General and Billing but removes Brand appearance and Desktop Policies", `Sidebar links: ${JSON.stringify(settingsLabels)}`, settingsOk);

  await user.click({ role: "link", label: "Plugin Directory" });
  const pluginsPath = await probe.eventually(() => world.location(), {
    within: 30_000, label: "Plugin Directory route", until: (path) => path === "/dashboard/plugins",
  });
  await user.see({ role: "tab", label: /^Sources/ }, { timeoutMs: 30_000 });
  await user.see({ text: "Create plugin" }, { timeoutMs: 30_000 });
  await user.click({ role: "tab", label: /^Sources/ });
  const sourceTabs = await probe.eventually(() => world.selectedTabs(), {
    within: 30_000, label: "Sources tab selected", until: (tabs) => tabs.length === 1 && tabs[0] === "Sources",
  });
  await user.see({ text: "GitHub" }, { timeoutMs: 30_000 });
  await user.see({ role: "button", label: "Connect" }, { timeoutMs: 30_000 });
  await user.notSee({ text: "Create plugin" }, { timeoutMs: 3_000 });
  const sourcesOk = pluginsPath === "/dashboard/plugins" && sourceTabs.length === 1 && sourceTabs[0] === "Sources";
  expect(sourcesOk).toBe(true);
  evidence.recordAssertionEvidence("Plugin Directory Sources shows GitHub Connect and hides Create plugin", `path=${pluginsPath}; selected=${JSON.stringify(sourceTabs)}; GitHub and Connect visible; Create plugin absent`, sourcesOk);
  await user.screenshot();

  await user.navigate(new URL("/dashboard/integrations", world.den.ref.webUrl).toString());
  const redirectPath = await probe.eventually(() => world.location(), {
    within: 30_000, label: "legacy integrations redirect", until: (path) => path === "/dashboard/plugins?view=sources",
  });
  const redirectedTabs = await probe.eventually(() => world.selectedTabs(), {
    within: 30_000, label: "redirected Sources tab selected", until: (tabs) => tabs.length === 1 && tabs[0] === "Sources",
  });
  const redirectOk = redirectPath === "/dashboard/plugins?view=sources" && redirectedTabs.length === 1 && redirectedTabs[0] === "Sources";
  expect(redirectOk).toBe(true);
  evidence.recordAssertionEvidence("The legacy integrations URL redirects only to Plugin Directory Sources", `path=${redirectPath}; selected=${JSON.stringify(redirectedTabs)}`, redirectOk);
});
