import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { denFlatPageHeaders, isRecord, type HeaderMeasurements } from "../worlds/den-flat-page-headers.ts";

const test = spec.world(denFlatPageHeaders, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

function feature(body: unknown, map: "features" | "capabilities"): unknown {
  const values = isRecord(body) ? body[map] : undefined;
  return isRecord(values) ? values.denFlatPageHeaders : undefined;
}

function roster(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.members) || !Array.isArray(body.teams)) {
    throw new Error("The organization read did not return its members and teams.");
  }
  const byId = (rows: unknown[]) => rows.filter(isRecord).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  return JSON.stringify({ members: byId(body.members), teams: byId(body.teams) });
}

function readableFlatHeading(measured: HeaderMeasurements, title: string, width: number) {
  expect(measured.title).toBe(title);
  expect(measured.flat).toBe(true);
  expect(measured.fontSize).toBeGreaterThan(0);
  expect(measured.fontSize).toBeLessThanOrEqual(20);
  expect(measured.fontWeight).toBe(600);
  expect(measured.inkLuminance).toBeLessThan(0.1);
  expect(measured.semanticInkMatch).toBe(true);
  expect(measured.contrast).toBeGreaterThanOrEqual(4.5);
  expect(measured.headerHeight).toBeLessThanOrEqual(40);
  expect(measured.headerImages).toEqual([]);
  expect(measured.canvasCount).toBe(0);
  expect(measured.textOverflow).not.toBe("ellipsis");
  expect(measured.heading.width).toBeGreaterThan(0);
  expect(measured.heading.left).toBeGreaterThanOrEqual(0);
  expect(measured.heading.right).toBeLessThanOrEqual(width);
  expect(measured.heading.scrollWidth).toBeLessThanOrEqual(measured.heading.clientWidth);
  expect(measured.widths.viewport).toBe(width);
  expect(measured.widths.document).toBeLessThanOrEqual(width);
  expect(measured.widths.main.scroll).toBeLessThanOrEqual(measured.widths.main.client);
  expect(measured.widths.shell.scroll).toBeLessThanOrEqual(measured.widths.shell.client);
}

function typographyEvidence(measured: HeaderMeasurements): string {
  return `“${measured.title}”: ${measured.fontSize}px, ${measured.contrast.toFixed(2)}:1 contrast, semantic ink=${measured.semanticInkMatch}; heading ${measured.heading.width}×${measured.heading.height}px, ${measured.heading.scrollWidth}/${measured.heading.clientWidth}px scroll/client width; header ${measured.headerHeight}px; ${measured.canvasCount} canvases and ${measured.headerImages.length} background images; document ${measured.widths.document}/${measured.widths.viewport}px.`;
}

// Use the actual Members, provider, and Analytics routes. The same owner enables
// and disables only their org in /admin; another org keeps the legacy banner.
// All feature writes after arrangement are trusted input through the admin UI.
test("an owner gets compact, readable page titles only in their rollout workspace and can restore the banner", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);
  const context = () => probe.api(world.den.admin, "/v1/org", { headers: world.scope });
  const adminCapabilities = `/v1/admin/organizations/${world.orgId}/capabilities`;
  let originalRoster = "";
  let originalNavigation: string[] = [];
  let originalAnalyticsNavigation: string[] = [];
  let originalCaptionHeight = 0;

  const openOrganizationControls = async () => {
    await owner.navigate(world.url("/admin"));
    await owner.see({ role: "button", label: /^Organizations/ }, { timeoutMs: 60_000 });
    await owner.click({ role: "button", label: /^Organizations/ });
    await owner.type({ placeholder: "Org name, slug, or id" }, world.slug);
    await owner.see({ testId: `admin-org-row-${world.slug}` }, { timeoutMs: 30_000 });
    await owner.see({ testId: "admin-capability-denFlatPageHeaders" });
  };
  const waitForOverride = async (enabled: boolean) => {
    await page.eventually(async () => feature((await probe.api(world.den.admin, adminCapabilities)).body, "capabilities"), {
      within: 30_000, label: `compact header rollout to be ${enabled ? "on" : "off"}`, until: (value) => value === enabled,
    });
  };

  await step("before: the owner's Members page keeps its banner while the rollout is off", async () => {
    await owner.see({ role: "heading", label: "Members" }, { timeoutMs: 90_000 });
    await owner.see({ role: "tab", label: /^Members/ });
    await owner.see({ text: "Header Member" });
    const before = await context();
    expect(before.response.ok).toBe(true);
    expect(feature(before.body, "features")).toBe(false);
    originalRoster = roster(before.body);
    originalNavigation = (await page.dom('[data-testid="den-org-sidebar"] a')).elements.map((entry) => entry.text);
    const measured = await world.measurements();
    expect(measured.flat).toBe(false);
    expect(measured.headerHeight).toBe(104);
    expect(measured.fontSize).toBe(24);
    expect(measured.headerImages.some((image) => image.includes("gradient")) || measured.canvasCount > 0).toBe(true);
    expect((await page.dom("[data-dashboard-flat-header]")).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("the default-off owner sees the unchanged banner and roster", `Den reports denFlatPageHeaders=false; Members uses the 104px banner and 24px heading, with gradient/canvas decoration. Header Owner and Header Member remain in the roster.`, true);
    await owner.screenshot();
  });

  await step("before: the same owner's Plugins & connectors page keeps its 22px Analytics title", async () => {
    await owner.navigate(world.url("/dashboard/analytics/library"));
    await owner.see({ testId: "library-usage" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "library-usage-toolbar" });
    await owner.see({ role: "heading", label: "Plugins & connectors" });
    const before = await context();
    expect(feature(before.body, "features")).toBe(false);
    expect(isRecord(before.body) && isRecord(before.body.features) && before.body.features.libraryUsage).toBe(true);
    expect(isRecord(before.body) && isRecord(before.body.entitlements) && before.body.entitlements.analytics).toBe(true);
    const report = await probe.api(world.den.admin, "/v1/library-usage/plugins?days=30", { headers: world.scope });
    expect(report.response.status).toBe(200);
    const measured = await world.measurements();
    expect(measured.title).toBe("Plugins & connectors");
    expect(measured.flat).toBe(false);
    expect(measured.fontSize).toBe(22);
    originalAnalyticsNavigation = (await page.dom('main nav[aria-label="Analytics views"] a')).elements.map((entry) => entry.text);
    const caption = (await page.dom("main header > div > div > div:last-child")).elements;
    expect(caption).toHaveLength(1);
    originalCaptionHeight = caption[0].rect.height;
    expect(originalCaptionHeight).toBeGreaterThanOrEqual(16);
    evidence.recordAssertionEvidence("the real Library usage page retains its legacy title before the header rollout", `Library usage was enabled by the world before acts; Analytics is entitled and its real plugin report returns HTTP ${report.response.status}. The owner's heading is 22px, with ${originalAnalyticsNavigation.length} Analytics destinations and a ${originalCaptionHeight}px reserved state line.`, true);
    await owner.screenshot();
  });

  await step("a platform admin enables compact page titles for this workspace in the existing admin controls", async () => {
    await openOrganizationControls();
    await owner.click({ testId: "admin-capability-denFlatPageHeaders" });
    await waitForOverride(true);
    const saved = await context();
    expect(feature(saved.body, "features")).toBe(true);
    expect(roster(saved.body)).toBe(originalRoster);
    evidence.recordAssertionEvidence("the organization override turns on only the header rollout", "The existing organization checkbox saved denFlatPageHeaders=true; the member and team records are byte-for-byte unchanged.", true);
    await owner.screenshot();
  });

  await step("after: the same owner's Members page has a readable compact title without a decorative banner", async () => {
    await owner.navigate(world.url("/dashboard/members"));
    await owner.see({ role: "heading", label: "Members" }, { timeoutMs: 60_000 });
    await owner.see({ role: "tab", label: /^Members/ });
    await owner.see({ role: "tab", label: /^Teams/ });
    await owner.see({ text: "Header Member" });
    await owner.see({ text: "Invite teammates, adjust roles, and keep access clean." });
    const measured = await world.measurements();
    readableFlatHeading(measured, "Members", 1280);
    expect((await page.dom("[data-dashboard-hero]")).elements).toHaveLength(0);
    expect(roster((await context()).body)).toBe(originalRoster);
    expect((await page.dom('[data-testid="den-org-sidebar"] a')).elements.map((entry) => entry.text)).toEqual(originalNavigation);
    evidence.recordAssertionEvidence("only the page header changes, with measurable dark ink on the plain page", `${typographyEvidence(measured)} Members and Teams, supporting context, navigation destinations, and the original roster remain.`, true);
    await owner.screenshot();
  });

  await step("after: Usage & adoption uses the shared compact title and keeps its refresh action", async () => {
    await owner.navigate(world.url("/dashboard/analytics"));
    await owner.see({ role: "heading", label: "Usage & adoption" }, { timeoutMs: 60_000 });
    await owner.see({ role: "button", label: "Refresh analytics" });
    await owner.see({ role: "link", label: "Plugins & connectors" });
    await owner.see({ role: "heading", label: "Usage & adoption" });
    const measured = await world.measurements();
    readableFlatHeading(measured, "Usage & adoption", 1280);
    expect((await page.dom('main nav[aria-label="Analytics views"] a')).elements.map((entry) => entry.text)).toEqual(originalAnalyticsNavigation);
    evidence.recordAssertionEvidence("the Analytics header follows the same organization rollout", `${typographyEvidence(measured)} Refresh analytics and every existing Analytics destination remain; tab and metric colors are outside this heading-only change.`, true);
    await owner.screenshot();
  });

  await step("after: the same owner's Plugins & connectors title is 20px semantic ink with its state line intact", async () => {
    await owner.navigate(world.url("/dashboard/analytics/library"));
    await owner.see({ testId: "library-usage-toolbar" }, { timeoutMs: 60_000 });
    await owner.see({ role: "heading", label: "Plugins & connectors" });
    const measured = await world.measurements();
    readableFlatHeading(measured, "Plugins & connectors", 1280);
    expect(measured.fontSize).toBe(20);
    const report = await probe.api(world.den.admin, "/v1/library-usage/plugins?days=30", { headers: world.scope });
    expect(report.response.status).toBe(200);
    expect((await page.dom('main nav[aria-label="Analytics views"] a')).elements.map((entry) => entry.text)).toEqual(originalAnalyticsNavigation);
    const caption = (await page.dom("main header > div > div > div:last-child")).elements;
    expect(caption).toHaveLength(1);
    expect(caption[0].rect.height).toBe(originalCaptionHeight);
    expect(roster((await context()).body)).toBe(originalRoster);
    evidence.recordAssertionEvidence("the Library usage title becomes compact without replacing its report or reserved state line", `${typographyEvidence(measured)} The same plugin report returns HTTP ${report.response.status}; its controls, Analytics destinations, and ${originalCaptionHeight}px state line remain.`, true);
    await owner.screenshot();
  });

  await step("after: the provider page uses the same compact heading and keeps its provider controls", async () => {
    await owner.navigate(world.url("/dashboard/custom-llm-providers"));
    await owner.see({ role: "heading", label: "Bring your Own Keys" }, { timeoutMs: 60_000 });
    await owner.see({ testId: "models-access-card" });
    await owner.see({ role: "link", label: "Add Provider" });
    await owner.see({ placeholder: "Search providers or models..." });
    await owner.see({ role: "heading", label: "Bring your Own Keys" });
    const measured = await world.measurements();
    readableFlatHeading(measured, "Bring your Own Keys", 1280);
    expect(measured.description).toContain("choose the exact models each one exposes");
    evidence.recordAssertionEvidence("the shared header leaves provider setup and model access intact", `${typographyEvidence(measured)} Add Provider, provider search, model-access choices, and credential context remain on the real provider page.`, true);
    await owner.screenshot();
  });

  await step("after: the provider title remains readable and does not overflow a 390px viewport", async () => {
    await owner.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await owner.see({ role: "link", label: "Add Provider" });
    await owner.see({ role: "heading", label: "Bring your Own Keys" });
    const measured = await world.measurements();
    readableFlatHeading(measured, "Bring your Own Keys", 390);
    evidence.recordAssertionEvidence("the compact provider header fits both its container and the narrow page", `${typographyEvidence(measured)} Main scroll/client width=${measured.widths.main.scroll}/${measured.widths.main.client}px; page shell=${measured.widths.shell.scroll}/${measured.widths.shell.client}px. No truncation or horizontal overflow.`, true);
    await owner.screenshot();
  });

  await step("another workspace still shows the legacy Members banner and only its own roster", async () => {
    await owner.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await owner.click({ testId: "workspace-switcher-trigger" });
    await owner.click({ role: "button", label: new RegExp(`^${world.names.otherWorkspace}`) });
    await owner.see({ testId: "workspace-switcher-trigger" }, { text: world.names.otherWorkspace, timeoutMs: 60_000 });
    await owner.navigate(world.url("/dashboard/members"));
    await owner.see({ role: "heading", label: "Members" }, { timeoutMs: 60_000 });
    await owner.notSee({ text: "Header Member" });
    const other = await probe.api(world.den.admin, "/v1/org", { headers: { "x-openwork-org-id": world.otherOrgId } });
    expect(other.response.ok).toBe(true);
    expect(feature(other.body, "features")).toBe(false);
    const measured = await world.measurements();
    expect(measured.flat).toBe(false);
    expect(measured.headerHeight).toBe(104);
    expect(measured.fontSize).toBe(24);
    expect((await page.dom("[data-dashboard-flat-header]")).elements).toHaveLength(0);
    expect(feature((await context()).body, "features")).toBe(true);
    expect(roster((await context()).body)).toBe(originalRoster);
    evidence.recordAssertionEvidence("the header rollout follows the active organization without leaking its roster", "The other organization reports denFlatPageHeaders=false and keeps its 104px banner/24px title. Header Member is absent there; the original workspace remains enabled with its unchanged roster.", true);
    await owner.screenshot();
  });

  await step("turning the workspace rollout off restores the same owner's banner without changing data or navigation", async () => {
    await owner.click({ testId: "workspace-switcher-trigger" });
    await owner.click({ role: "button", label: new RegExp(`^${world.names.workspace}`) });
    await owner.see({ testId: "workspace-switcher-trigger" }, { text: world.names.workspace, timeoutMs: 60_000 });
    await openOrganizationControls();
    await owner.click({ testId: "admin-capability-denFlatPageHeaders" });
    await waitForOverride(false);
    await owner.navigate(world.url("/dashboard/members"));
    await owner.see({ role: "heading", label: "Members" }, { timeoutMs: 60_000 });
    await owner.see({ text: "Header Member" });
    const after = await context();
    expect(feature(after.body, "features")).toBe(false);
    expect(roster(after.body)).toBe(originalRoster);
    const measured = await world.measurements();
    expect(measured.flat).toBe(false);
    expect(measured.headerHeight).toBe(104);
    expect(measured.fontSize).toBe(24);
    expect((await page.dom("[data-dashboard-flat-header]")).elements).toHaveLength(0);
    expect((await page.dom('[data-testid="den-org-sidebar"] a')).elements.map((entry) => entry.text)).toEqual(originalNavigation);
    evidence.recordAssertionEvidence("reverting the header needs no data migration or alternate route", "The existing admin checkbox saved false; the original 104px banner and 24px Members title returned. Member/team records and navigation destinations still match the feature-off starting state.", true);
    await owner.screenshot();
  });

  await step("turning the rollout off also restores the Library usage title without changing its navigation", async () => {
    await owner.navigate(world.url("/dashboard/analytics/library"));
    await owner.see({ testId: "library-usage-toolbar" }, { timeoutMs: 60_000 });
    await owner.see({ role: "heading", label: "Plugins & connectors" });
    const measured = await world.measurements();
    expect(measured.flat).toBe(false);
    expect(measured.fontSize).toBe(22);
    expect((await page.dom("[data-dashboard-flat-header]")).elements).toHaveLength(0);
    expect((await page.dom('main nav[aria-label="Analytics views"] a')).elements.map((entry) => entry.text)).toEqual(originalAnalyticsNavigation);
    const caption = (await page.dom("main header > div > div > div:last-child")).elements;
    expect(caption).toHaveLength(1);
    expect(caption[0].rect.height).toBe(originalCaptionHeight);
    evidence.recordAssertionEvidence("Analytics uses the same safe fallback as the dashboard template", `The same owner's Library usage heading returns to 22px after the organization override is turned off; all Analytics destinations and the ${originalCaptionHeight}px state line are unchanged.`, true);
    await owner.screenshot();
  });
});
