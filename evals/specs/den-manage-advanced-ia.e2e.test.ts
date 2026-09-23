import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { adminDashboardWeb } from "../worlds/den-admin-navigation.ts";

// The Den admin sidebar has two jobs: Work for everyone, and Manage plus Team
// for admins. Collections and Brand appearance live in Settings › Advanced,
// Desktop policies is its own Manage entry, and Plugins lists plugins without
// GitHub sources while the legacy integrations URL still opens its old tab.
const test = spec.world(adminDashboardWeb, { timeout: 420_000 });

test("the Den admin sidebar groups Manage and moves Advanced into Settings", async ({ world, user, probe, evidence }) => {
  await user.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
  const manage = ["Plugins", "Connectors", "AI Gateway", "Desktop policies", "Analytics", "Members", "Settings"];
  const initialLabels = await probe.eventually(() => world.sidebarLinks(), {
    within: 30_000,
    label: "Manage and Team navigation",
    until: (labels) => manage.every((label) => labels.includes(label)),
  });
  const initialOk = manage.every((label) => initialLabels.includes(label))
    && ["My Library"].every((label) => initialLabels.includes(label))
    && !["Plugin Directory", "Advanced", "Collections", "Sources", "Brand appearance", "Dashboard"].some((label) => initialLabels.includes(label));
  expect(initialOk).toBe(true);
  evidence.recordAssertionEvidence("The sidebar has Work, Manage and Team without Plugin Directory or a top-level Advanced", `Sidebar links: ${JSON.stringify(initialLabels)}`, initialOk);
  await user.screenshot();

  await user.click({ role: "link", label: "Desktop policies" });
  const desktopPath = await probe.eventually(() => world.location(), {
    within: 30_000, label: "Desktop policies route", until: (path) => path === "/dashboard/desktop-policies",
  });
  expect(desktopPath).toBe("/dashboard/desktop-policies");

  await user.click({ role: "link", label: "Settings" });
  const settingsLabels = await probe.eventually(() => world.sidebarLinks(), {
    within: 30_000,
    label: "expanded Settings children",
    until: (labels) => labels.includes("General") && labels.includes("Advanced"),
  });
  const settingsOk = settingsLabels.includes("General") && settingsLabels.includes("Billing") && settingsLabels.includes("Advanced")
    && !settingsLabels.includes("Brand appearance") && !settingsLabels.includes("Desktop Policies");
  expect(settingsOk).toBe(true);
  evidence.recordAssertionEvidence("Expanded Settings holds General, Billing and Advanced", `Sidebar links: ${JSON.stringify(settingsLabels)}`, settingsOk);

  await user.click({ role: "link", label: "Advanced" });
  const advancedPath = await probe.eventually(() => world.location(), {
    within: 30_000, label: "Advanced route", until: (path) => path === "/dashboard/marketplaces",
  });
  const collectionsTabs = await probe.eventually(() => world.selectedTabs(), {
    within: 30_000, label: "Collections tab selected", until: (tabs) => tabs.length === 1 && tabs[0] === "Collections",
  });
  const advancedOk = advancedPath === "/dashboard/marketplaces" && collectionsTabs[0] === "Collections";
  expect(advancedOk).toBe(true);
  evidence.recordAssertionEvidence("Settings › Advanced opens Collections at /dashboard/marketplaces", `path=${advancedPath}; selected=${JSON.stringify(collectionsTabs)}`, advancedOk);
  await user.screenshot();

  await user.click({ role: "tab", label: "Brand appearance" });
  await probe.eventually(() => world.location(), {
    within: 30_000, label: "Brand appearance route", until: (path) => path === "/dashboard/brand-appearance",
  });
  await user.see({ testId: "brand-appearance-screen" }, { timeoutMs: 30_000 });

  await user.click({ role: "link", label: "Plugins" });
  const pluginsPath = await probe.eventually(() => world.location(), {
    within: 30_000, label: "Plugins route", until: (path) => path === "/dashboard/plugins",
  });
  await user.see({ testId: "admin-plugins" }, { timeoutMs: 30_000 });
  await user.see({ role: "link", label: "Create a plugin" }, { timeoutMs: 30_000 });
  await user.notSee({ role: "tab", label: /^Sources/ }, { timeoutMs: 3_000 });
  await user.notSee({ text: "GitHub" }, { timeoutMs: 3_000 });
  const pluginsOk = pluginsPath === "/dashboard/plugins";
  expect(pluginsOk).toBe(true);
  evidence.recordAssertionEvidence("Plugins lists plugins with Create a plugin and no GitHub Sources tab", `path=${pluginsPath}; Create a plugin visible; Sources and GitHub absent`, pluginsOk);
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
  evidence.recordAssertionEvidence("The legacy integrations URL redirects only to Plugins Sources", `path=${redirectPath}; selected=${JSON.stringify(redirectedTabs)}`, redirectOk);
});
