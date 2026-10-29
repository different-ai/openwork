import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { adminOverviewWorld } from "../worlds/admin-overview.ts";

const test = spec.world(adminOverviewWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

test("a platform admin scans organizations as compact rows and jumps back to the ones they opened", async ({ world, user, probe, step, evidence }) => {
  const admin = user.on(world.admin);
  const adminProbe = probe.on(world.admin);
  const organizationName = "Overview workspace";

  await step("before: the overview has no recently viewed organizations yet", async () => {
    await admin.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await admin.navigate(world.url("/admin"));
    await admin.see({ role: "heading", label: "Overview" }, { timeoutMs: 60_000 });
    await admin.see({ testId: "admin-recent-organizations" }, { text: /Organizations you open appear here/ });
    const links = await adminProbe.dom('[data-testid="admin-recent-organizations"] a');
    evidence.recordAssertionEvidence("Recently viewed starts empty in a fresh browser", `recent links=${links.elements.length}`, links.elements.length === 0);
    expect(links.elements.length).toBe(0);
    await admin.screenshot();
  });

  await step("after: each organization is one compact row with its plan, users and a Billing link, and no per-row editor", async () => {
    await admin.navigate(world.url("/admin/organizations?search=Routing"));
    const first = await world.firstRow("organizations", "Routing", 1);
    await admin.see({ testId: first }, { timeoutMs: 60_000 });
    const rows = await adminProbe.dom('[data-testid^="admin-org-row-"]');
    const editors = await adminProbe.dom('[id^="admin-org-manage-"], button[aria-label^="Manage "]');
    const billingLinks = await adminProbe.dom('[data-testid="admin-organization-billing-link"]');
    const tallest = Math.max(...rows.elements.map((row) => row.rect.height));
    const ok = rows.elements.length === 50 && tallest <= 120 && editors.elements.length === 0 && billingLinks.elements.length === 50;
    evidence.recordAssertionEvidence("A full page of organizations reads as short rows, each with a Billing link and no Manage panel", `rows=${rows.elements.length}; tallest row=${Math.round(tallest)}px; Manage panels=${editors.elements.length}; Billing links=${billingLinks.elements.length}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("Billing opens the organization's plan and users in one place", async () => {
    await admin.navigate(world.url("/admin/organizations?search=Overview%20workspace"));
    await admin.click({ role: "link", label: `Billing for ${organizationName}` });
    await admin.see({ testId: "admin-organization-billing" }, { timeoutMs: 60_000 });
    await admin.see({ role: "button", label: "Save plan" });
    const location = await world.location();
    const ok = location.pathname === `${world.detailPath}/billing`;
    evidence.recordAssertionEvidence("The row's Billing link opens the organization's Billing tab", `pathname=${location.pathname}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
    await admin.navigate(world.url("/admin/organizations?search=Overview%20workspace"));
  });

  await step("opening the organization takes the admin to its member page", async () => {
    await admin.click({ role: "link", label: organizationName });
    await admin.see({ testId: "admin-breadcrumb-current" }, { text: organizationName, timeoutMs: 60_000 });
    await admin.see({ role: "heading", label: "Members" });
    const location = await world.location();
    const ok = location.pathname === world.detailPath;
    evidence.recordAssertionEvidence("The organization page opened from the list", `pathname=${location.pathname}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("after: the overview lists the organization under Recently viewed and one click reopens it", async () => {
    await admin.click({ testId: "admin-breadcrumb-admin" });
    await admin.see({ testId: "admin-recent-organizations" }, { text: new RegExp(organizationName) });
    await admin.screenshot();
    await admin.click({ role: "link", label: new RegExp(`^${organizationName}, viewed `) });
    await admin.see({ testId: "admin-breadcrumb-current" }, { text: organizationName, timeoutMs: 60_000 });
    const location = await world.location();
    const ok = location.pathname === world.detailPath;
    evidence.recordAssertionEvidence("The recent entry links straight back to the organization", `pathname=${location.pathname}`, ok);
    expect(ok).toBe(true);
  });

  await step("after: the overview compares the last 7 days with the previous 7 and says what needs attention", async () => {
    await admin.click({ testId: "admin-breadcrumb-admin" });
    await admin.see({ testId: "admin-dashboard-attention" }, { text: /Last 7 days/, timeoutMs: 60_000 });
    await admin.see({ testId: "admin-dashboard-attention" }, { text: /missing a price/ });
    const report = await world.dashboard();
    const attention = await adminProbe.dom('[data-testid="admin-dashboard-attention"]');
    const text = attention.elements[0]?.text ?? "";
    const ok = report.totals.unpricedRequests === null && text.includes("AI requests") && text.includes("Recorded cost") && text.includes("missing a price");
    evidence.recordAssertionEvidence("Week-over-week usage and the price-coverage gap appear above the chart", `unpriced=${String(report.totals.unpricedRequests)}; panel="${text.slice(0, 160)}"`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("on a phone the organization list and its recent shortcuts fit without sideways scrolling", async () => {
    await admin.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await admin.navigate(world.url("/admin/organizations?search=Overview%20workspace"));
    await admin.see({ testId: "admin-recent-organizations-strip" }, { text: new RegExp(organizationName), timeoutMs: 60_000 });
    const layout = await adminProbe.dom("body");
    const ok = layout.documentWidth <= layout.viewportWidth;
    evidence.recordAssertionEvidence("The compact list fits a 390 px screen", `document=${layout.documentWidth}px; viewport=${layout.viewportWidth}px`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
    await admin.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  });
});
