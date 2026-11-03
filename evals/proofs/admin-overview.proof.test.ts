import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { adminOverviewWorld } from "../worlds/admin-overview.ts";

const test = spec.world(adminOverviewWorld, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den"] },
});

test("an admin navigates organizations and member usage without loading every detail", async ({ world, user, probe, step, evidence }) => {
  const anonymous = user.on(world.anonymous);
  const anonymousProbe = probe.on(world.anonymous);
  const admin = user.on(world.admin);
  const adminProbe = probe.on(world.admin);
  const member = user.on(world.member);

  await step("before: a signed-out visitor sees sign-in without a dashboard skeleton", async () => {
    await anonymous.see({ role: "heading", label: "Sign in required" });
    const skeletons = await anonymousProbe.dom('[aria-busy="true"], .animate-pulse');
    const traffic = await world.traffic("anonymous");
    const ok = skeletons.elements.length === 0 && traffic.overview === 0 && traffic.usage === 0 && traffic.dashboard === 0;
    evidence.recordAssertionEvidence("Signed-out visitors never start dashboard work", `skeletons=${skeletons.elements.length}; overview requests=${traffic.overview}; usage requests=${traffic.usage}`, ok);
    expect(ok).toBe(true);
    await anonymous.screenshot();
  });

  await step("the admin reads the overview while model consumption remains below the viewport", async () => {
    await admin.see({ role: "heading", label: "Users" }, { timeoutMs: 60_000 });
    await admin.see({ testId: "admin-breadcrumb-current" }, { text: "Users" });
    const deferred = await adminProbe.dom('[data-admin-deferred="pending"]');
    const traffic = await world.traffic("admin");
    const ok = deferred.elements.length === 1 && deferred.elements[0].rect.top > 520 && traffic.usage === 0 && traffic.metrics === 0 && traffic.overview === 0;
    evidence.recordAssertionEvidence("The Users route loads its own page while distant consumption waits", `section top=${deferred.elements[0]?.rect.top}px; viewport=120px; margin=400px; usage=${traffic.usage}; analytics=${traffic.metrics}; overview=${traffic.overview}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("after: scrolling to model consumption loads it once", async () => {
    await admin.resizeViewport({ width: 1280, height: 700, deviceScaleFactor: 1 });
    await admin.wheelAt({ x: 1000, y: 500, deltaY: 1600 });
    await admin.see({ testId: "admin-usage-section" });
    const traffic = await adminProbe.eventually(() => world.traffic("admin"), { within: 15_000, until: (value) => value.usage === 1, label: "visible consumption read" });
    await admin.wheelAt({ x: 1000, y: 500, deltaY: -1600 });
    await admin.wheelAt({ x: 1000, y: 500, deltaY: 1600 });
    const repeated = await world.traffic("admin");
    const ok = traffic.usage === 1 && repeated.usage === 1;
    evidence.recordAssertionEvidence("Revisiting the section reuses the loaded consumption", `first visit=${traffic.usage}; second visit=${repeated.usage}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("before: the organization list links to features without loading the editors", async () => {
    await admin.click({ role: "link", label: "Organizations" });
    await admin.see({ role: "heading", label: "Organizations" });
    await admin.see({ testId: "admin-organization-features-link" });
    const controls = await adminProbe.dom('[data-testid^="admin-capability-"]');
    const traffic = await world.traffic("admin");
    const payloads = await world.organizationPayloads();
    const ok = controls.elements.length === 0 && traffic.features === 0 && traffic.lightOrganizations === 1
      && payloads.fullCount > 0 && payloads.lightCount === payloads.fullCount && payloads.fullWithFeatures === payloads.fullCount
      && payloads.lightWithFeatures === 0 && payloads.lightBytes < payloads.fullBytes;
    evidence.recordAssertionEvidence("The organization list stays light and gives feature settings a dedicated destination", `controls=${controls.elements.length}; feature reads=${traffic.features}; page payload=${payloads.fullBytes} → ${payloads.lightBytes} characters`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("after: the admin controls features inside the organization", async () => {
    await admin.type({ role: "textbox", label: "Search organizations" }, "Overview workspace", { replace: true });
    await admin.see({ role: "link", label: "Overview workspace" });
    await admin.click({ testId: "admin-organization-features-link" });
    await admin.see({ role: "heading", label: "Overview workspace" });
    await admin.see({ role: "heading", label: "Features" });
    await admin.see({ testId: "admin-breadcrumb-current" }, { text: "Features" });
    await admin.see({ testId: "admin-capability-settledSessions" });
    const tabs = await adminProbe.dom('nav[aria-label="Organization sections"] [aria-current="page"]');
    const traffic = await world.traffic("admin");
    const location = await world.location();
    const blocked = await adminProbe.dom('[data-testid="admin-capability-computerUse"][disabled]');
    const ok = location.pathname === `${world.detailPath}/features` && tabs.elements[0]?.text === "Features"
      && traffic.features === 1 && traffic.organizationUsage === 0 && traffic.organizationInsights === 0 && blocked.elements.length === 1;
    evidence.recordAssertionEvidence("The Features tab loads only this organization's flags and keeps the global kill switch locked", `${JSON.stringify(location)}; feature reads=${traffic.features}; locked controls=${blocked.elements.length}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("the admin's override survives refresh and leaves other organizations unchanged", async () => {
    const otherBefore = await world.featureState("settledSessions", true);
    await admin.click({ testId: "admin-capability-settledSessions" });
    const saved = await adminProbe.eventually(() => world.featureState("settledSessions"), { within: 10_000, until: (value) => value.override === true, label: "saved organization override" });
    await admin.reload();
    await admin.see({ testId: "admin-capability-source-settledSessions" }, { text: "Set for this organization" });
    const enabled = await adminProbe.dom('[data-testid="admin-capability-settledSessions"][aria-checked="true"]');
    const otherAfter = await world.featureState("settledSessions", true);
    const ok = saved.enabled === true && enabled.elements.length === 1 && JSON.stringify(otherAfter) === JSON.stringify(otherBefore);
    evidence.recordAssertionEvidence("A feature override persists for the selected organization only", `own=${JSON.stringify(saved)}; other=${JSON.stringify(otherAfter)}; checked controls=${enabled.elements.length}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("long feature names, descriptions and reset actions fit a phone", async () => {
    await admin.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await admin.see({ testId: "admin-capability-reset-workbotDocuments" });
    const phone = await adminProbe.dom('[data-testid="admin-organization-features"] li, [data-testid="admin-organization-features"] label, [data-testid="admin-organization-features"] button');
    const phoneFits = phone.documentWidth <= phone.viewportWidth && phone.elements.every((entry) => entry.rect.left >= 0 && entry.rect.left + entry.rect.width <= phone.viewportWidth);
    expect(phoneFits).toBe(true);
    await admin.screenshot();
    await admin.resizeViewport({ width: 320, height: 740, deviceScaleFactor: 1 });
    await admin.see({ testId: "admin-capability-workbotDocuments" });
    const compact = await adminProbe.dom('[data-testid="admin-organization-features"] li, [data-testid="admin-organization-features"] label, [data-testid="admin-organization-features"] button, nav[aria-label="Organization sections"] a');
    const ok = compact.documentWidth <= compact.viewportWidth && compact.elements.length > 0 && compact.elements.every((entry) => entry.rect.left >= 0 && entry.rect.left + entry.rect.width <= compact.viewportWidth);
    evidence.recordAssertionEvidence("Feature text, full-size switches, reset actions and tabs stay inside 390px and 320px screens", `390px document=${phone.documentWidth}; 320px document=${compact.documentWidth}; checked elements=${compact.elements.length}`, phoneFits && ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("the admin can turn a feature off and then return to everyone's setting", async () => {
    await admin.click({ testId: "admin-capability-settledSessions" });
    const off = await adminProbe.eventually(() => world.featureState("settledSessions"), { within: 10_000, until: (value) => value.override === false, label: "disabled organization override" });
    expect(off.enabled).toBe(false);
    await admin.click({ testId: "admin-capability-reset-settledSessions" });
    const reset = await adminProbe.eventually(() => world.featureState("settledSessions"), { within: 10_000, until: (value) => value.override === null, label: "reset organization override" });
    await admin.reload();
    await admin.see({ testId: "admin-capability-source-settledSessions" }, { text: "Off for everyone" });
    const resetButtons = await adminProbe.dom('[data-testid="admin-capability-reset-settledSessions"]');
    const ok = reset.override === null && reset.source === "everyone" && reset.enabled === false && resetButtons.elements.length === 0;
    evidence.recordAssertionEvidence("Both an explicit off override and reset to the deployment default survive saving", `off=${JSON.stringify(off)}; reset=${JSON.stringify(reset)}; reset buttons=${resetButtons.elements.length}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
    await admin.resizeViewport({ width: 1280, height: 700, deviceScaleFactor: 1 });
  });

  await step("deployment-wide rollout controls also fit a narrow screen", async () => {
    await admin.resizeViewport({ width: 320, height: 740, deviceScaleFactor: 1 });
    await admin.navigate(world.url("/admin/features"));
    await admin.see({ role: "heading", label: "Features" });
    await admin.see({ testId: "admin-feature-settledSessions" });
    const layout = await adminProbe.dom('li[data-testid^="admin-feature-"], li[data-testid^="admin-feature-"] button');
    const ok = layout.documentWidth <= layout.viewportWidth && layout.elements.length > 0 && layout.elements.every((entry) => entry.rect.left >= 0 && entry.rect.left + entry.rect.width <= layout.viewportWidth);
    evidence.recordAssertionEvidence("The global rollout and kill-switch actions wrap without horizontal overflow at 320px", `document=${layout.documentWidth}; viewport=${layout.viewportWidth}; controls=${layout.elements.length}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
    await admin.resizeViewport({ width: 1280, height: 700, deviceScaleFactor: 1 });
  });

  await step("a direct Users link and refresh restore its search and second page", async () => {
    const first = await world.firstRow("users", "Routing", 2);
    await admin.navigate(world.url("/admin/users?search=Routing&page=2"));
    await admin.see({ testId: first });
    await admin.see({ role: "textbox", label: "Search users" }, { value: "Routing" });
    await admin.reload();
    await admin.see({ testId: first }, { timeoutMs: 60_000 });
    const location = await world.location();
    const traffic = await world.traffic("admin");
    const ok = location.pathname === "/admin/users" && location.search === "Routing" && location.page === 2 && location.active === "Users" && traffic.overview === 0 && traffic.lightOrganizations === 0;
    evidence.recordAssertionEvidence("Users deep links survive refresh without fetching overview or organizations", `location=${JSON.stringify(location)}; overview=${traffic.overview}; organization reads=${traffic.lightOrganizations}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("browser Back and Forward restore the user's paginated results", async () => {
    const firstPage = await world.firstRow("users", "Routing", 1);
    const secondPage = await world.firstRow("users", "Routing", 2);
    await admin.click({ role: "button", label: "Previous" });
    await admin.see({ testId: firstPage });
    await admin.click({ role: "button", label: "Next" });
    await admin.see({ testId: secondPage });
    await world.history("back");
    await admin.see({ testId: firstPage });
    const back = await world.location();
    await world.history("forward");
    await admin.see({ testId: secondPage });
    const forward = await world.location();
    const ok = back.page === 1 && forward.page === 2 && back.search === "Routing" && forward.search === "Routing";
    evidence.recordAssertionEvidence("Browser history restores both the URL and matching user rows", `back=${JSON.stringify(back)}; forward=${JSON.stringify(forward)}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("changing user search resets the page and survives refresh", async () => {
    const first = await world.firstRow("users", "Routing user 00", 1);
    await admin.type({ role: "textbox", label: "Search users" }, "Routing user 00", { replace: true });
    await admin.see({ testId: first });
    await admin.reload();
    await admin.see({ testId: first }, { timeoutMs: 60_000 });
    await admin.see({ role: "textbox", label: "Search users" }, { value: "Routing user 00" });
    const location = await world.location();
    evidence.recordAssertionEvidence("User search and the reset to page one are kept in the URL", JSON.stringify(location), location.page === 1 && location.search === "Routing user 00");
    expect(location.page).toBe(1);
    expect(location.search).toBe("Routing user 00");
    await admin.screenshot();
  });

  await step("an Organizations deep link restores search and pagination with the correct sidebar item", async () => {
    const secondPage = await world.firstRow("organizations", "Routing", 2);
    await admin.navigate(world.url("/admin/organizations?search=Routing&page=2"));
    await admin.see({ testId: secondPage });
    await admin.reload();
    await admin.see({ testId: secondPage }, { timeoutMs: 60_000 });
    await admin.click({ role: "button", label: "Previous" });
    await admin.see({ testId: await world.firstRow("organizations", "Routing", 1) });
    await admin.click({ role: "button", label: "Next" });
    await admin.see({ testId: secondPage });
    await world.history("back");
    await admin.see({ testId: await world.firstRow("organizations", "Routing", 1) });
    const back = await world.location();
    await world.history("forward");
    await admin.see({ testId: secondPage });
    const location = await world.location();
    const traffic = await world.traffic("admin");
    const ok = back.page === 1 && back.search === "Routing" && location.pathname === "/admin/organizations" && location.page === 2 && location.search === "Routing" && location.active === "Organizations" && traffic.overview === 0 && traffic.users === 0 && traffic.features === 0;
    evidence.recordAssertionEvidence("Organization routes restore their list and browser history without loading users or feature maps", `back=${JSON.stringify(back)}; forward=${JSON.stringify(location)}; overview=${traffic.overview}; users=${traffic.users}; feature reads=${traffic.features}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("breadcrumbs return from an organization's usage to the filtered second list page", async () => {
    const secondPage = await world.firstRow("organizations", "Routing", 2);
    const links = await adminProbe.dom('[data-testid^="admin-org-row-"] a');
    const organizationName = links.elements[0]?.text;
    if (!organizationName) throw new Error("Expected an organization link on the second page.");
    await admin.click({ role: "link", label: organizationName });
    await admin.see({ testId: "admin-breadcrumb-current" }, { text: organizationName });
    await admin.click({ role: "link", label: "Usage" });
    await admin.see({ testId: "admin-breadcrumb-organization" }, { text: organizationName });
    await admin.see({ testId: "admin-breadcrumb-current" }, { text: "Usage" });
    await admin.reload();
    await admin.see({ testId: "admin-breadcrumb-current" }, { text: "Usage" });
    await admin.click({ testId: "admin-breadcrumb-organization" });
    await admin.see({ role: "heading", label: "Members" });
    await admin.click({ testId: "admin-breadcrumb-organizations" });
    await admin.see({ testId: secondPage });
    const location = await world.location();
    const ok = location.pathname === "/admin/organizations" && location.search === "Routing" && location.page === 2;
    evidence.recordAssertionEvidence("Breadcrumb parents preserve the organization list's search and page after refresh", JSON.stringify(location), ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("organization search resets the page and every admin section is visible on a narrow screen", async () => {
    const first = await world.firstRow("organizations", "Routing organization 00", 1);
    await admin.type({ role: "textbox", label: "Search organizations" }, "Routing organization 00", { replace: true });
    await admin.see({ testId: first });
    await admin.reload();
    await admin.see({ testId: first }, { timeoutMs: 60_000 });
    await admin.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await admin.see({ role: "textbox", label: "Search organizations" }, { value: "Routing organization 00" });
    const location = await world.location();
    const layout = await adminProbe.dom("body");
    const navigation = await adminProbe.dom('[data-testid="admin-navigation"] a');
    expect(navigation.elements.map((link) => link.text)).toEqual([
      "Overview", "Users", "Organizations", "Opportunities", "Sandboxes", "Features", "Feature rollouts", "Free Auto usage", "Security", "Services",
    ]);
    const visibleSections = navigation.elements.every((link) => link.rect.left >= 0 && link.rect.left + link.rect.width <= navigation.viewportWidth);
    const ok = location.page === 1 && location.search === "Routing organization 00" && layout.documentWidth <= layout.viewportWidth && visibleSections;
    evidence.recordAssertionEvidence("Every admin destination fits the compact navigation without sideways scrolling", `${JSON.stringify(location)}; sections=${navigation.elements.length}; document=${layout.documentWidth}px; viewport=${layout.viewportWidth}px`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("after: opening an organization shows its bounded member page without loading usage", async () => {
    await admin.resizeViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    await admin.navigate(world.url("/admin/organizations?search=Overview"));
    await admin.click({ role: "link", label: "Overview workspace" });
    await admin.see({ role: "heading", label: "Overview workspace" });
    await admin.see({ role: "heading", label: "Members" });
    const rows = await adminProbe.dom('[data-testid^="admin-organization-member-"]');
    const traffic = await world.traffic("admin");
    const detail = await world.organizationMembers();
    const location = await world.location();
    const ok = rows.elements.length === 50 && detail.page.total === 53 && detail.organization.memberCount === 53 && location.pathname === world.detailPath && location.active === "Organizations" && traffic.organizationUsage === 0;
    evidence.recordAssertionEvidence("An organization has its own member page and usage remains deferred", `visible=${rows.elements.length}; total=${detail.page.total}; route=${location.pathname}; usage reads=${traffic.organizationUsage}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("organization member search and pagination survive refresh", async () => {
    const secondPageMember = (await world.organizationMembers("offset=50")).members[0];
    if (!secondPageMember) throw new Error("Expected an organization member on the second page.");
    await admin.click({ role: "button", label: "Next" });
    await admin.see({ testId: `admin-organization-member-${secondPageMember.id}` });
    await admin.reload();
    await admin.see({ testId: `admin-organization-member-${secondPageMember.id}` }, { timeoutMs: 60_000 });
    await admin.type({ role: "textbox", label: "Search members" }, "Routing user 00", { replace: true });
    await admin.see({ testId: `admin-organization-member-${world.memberId}` });
    await admin.reload();
    await admin.see({ role: "textbox", label: "Search members" }, { value: "Routing user 00" });
    const location = await world.location();
    const rows = await adminProbe.dom('[data-testid^="admin-organization-member-"]');
    const ok = location.search === "Routing user 00" && location.page === 1 && rows.elements.length === 1;
    evidence.recordAssertionEvidence("Member filtering is scoped to the organization and stored in the URL", `${JSON.stringify(location)}; visible=${rows.elements.length}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("the organization Usage route shows recorded and retained usage with a scoped member breakdown", async () => {
    await admin.click({ role: "link", label: "Usage" });
    await admin.see({ testId: "admin-organization-usage" });
    await admin.see({ testId: `admin-organization-member-usage-${world.memberId}` }, { text: /\$1\.75/ });
    const report = await world.organizationUsage("search=Routing%20user%2000");
    const own = report.usage.members.find((row) => row.memberId === world.memberId);
    const totals = report.usage.totals;
    const location = await world.location();
    const ok = totals.requests === 7 && totals.tokens === 270 && totals.costMicroUsd === 2_000_000 && totals.unreportedRequests === null && totals.unpricedRequests === null && own?.requests === 4 && own.tokens === 200 && own.costMicroUsd === 1_750_000 && report.members.length === 1 && location.pathname === `${world.detailPath}/usage` && location.search === "Routing user 00";
    evidence.recordAssertionEvidence("Organization totals include removed members, exclude other organizations and retain unknown accounting", `totals=${JSON.stringify(totals)}; member=${JSON.stringify(own)}; rows=${report.members.length}; route=${location.pathname}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("unknown prices remain visible and the Usage deep link restores its second member page on mobile", async () => {
    const secondPageMember = (await world.organizationMembers("offset=50")).members[0];
    if (!secondPageMember) throw new Error("Expected a usage member on the second page.");
    await admin.type({ role: "textbox", label: "Search members" }, "", { replace: true });
    await admin.see({ testId: `admin-organization-member-usage-${world.unpricedMemberId}` }, { text: /Unknown/ });
    await admin.click({ role: "button", label: "Next" });
    await admin.see({ testId: `admin-organization-member-${secondPageMember.id}` });
    await admin.reload();
    await admin.see({ testId: `admin-organization-member-${secondPageMember.id}` }, { timeoutMs: 60_000 });
    await admin.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const layout = await adminProbe.dom("body");
    const location = await world.location();
    const ok = location.page === 2 && location.pathname === `${world.detailPath}/usage` && layout.documentWidth <= layout.viewportWidth;
    evidence.recordAssertionEvidence("The routed Usage page preserves pagination and fits a narrow screen", `${JSON.stringify(location)}; document=${layout.documentWidth}; viewport=${layout.viewportWidth}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("after: organization insights rank people and models, compare periods and show an activity chart", async () => {
    // Keep the models section beyond the observer's 400px prefetch margin,
    // including while the earlier lazy charts are still settling their layout.
    await admin.resizeViewport({ width: 1280, height: 700, deviceScaleFactor: 1 });
    // A fresh deep link starts at the top, independent of the preceding Usage
    // page's pagination/viewport scroll restoration during client navigation.
    await admin.navigate(world.url(`${world.detailPath}/insights`));
    // Target the top statistic: locating the entire tall panel scrolls down
    // and loads charts before the deferred-loading assertion can observe them.
    await admin.see({ text: "Active member adoption" });
    await admin.see({ testId: "admin-breadcrumb-current" }, { text: "Insights" });
    const deferredModels = await adminProbe.eventually(
      () => adminProbe.dom('[aria-label="Most used models"] [data-admin-deferred="pending"]'),
      { within: 10_000, until: (value) => value.elements.length === 1, label: "the below-prefetch model chart placeholder is mounted" },
    );
    expect(deferredModels.elements).toHaveLength(1);
    expect(deferredModels.elements[0].rect.top).toBeGreaterThan(700 + 400);
    expect((await adminProbe.dom('[aria-label="Top eight models by AI requests"]')).elements).toHaveLength(0);
    const report = await world.organizationInsights();
    const { current, previous, daily, people, models } = report.insights;
    const ok = current.requests === 7 && previous.requests === 3 && current.activeMembers === 2 && previous.activeMembers === 1
      && current.successfulRequests === 7 && daily.length === 30 && daily.reduce((sum, day) => sum + day.requests, 0) === 7
      && people.length <= 8 && people[0].memberId === world.memberId && people[0].requests === 4
      && models[0].name === "test-active-model" && models[0].requests === 4
      && !models.some((model) => model.name.includes("previous-period") || model.name.includes("outside-window"))
      && current.costMicroUsd === 2000000 && current.unpricedRequests === null;
    evidence.recordAssertionEvidence("Insights preserve organization scope, retained usage, period bounds, current-member adoption and leader rankings", JSON.stringify({ current, previous, people: people.length, models, deferredModelChartTop: deferredModels.elements[0].rect.top, prefetchBoundary: 700 + 400 }), ok);
    expect(ok).toBe(true);
    await admin.click({ role: "button", label: "Chart metric" });
    await admin.click({ role: "option", label: "Active members" });
    await admin.see({ testId: "admin-dashboard-chart-activeMembers" });
    await admin.screenshot();
    await admin.wheelAt({ x: 1000, y: 600, deltaY: 700 });
    await admin.see({ role: "heading", label: "Most active people" });
    await admin.screenshot();
    await admin.wheelAt({ x: 1000, y: 600, deltaY: 700 });
    await admin.see({ role: "heading", label: "Most used models" });
    const modelChart = await adminProbe.eventually(() => adminProbe.dom('[aria-label="Top eight models by AI requests"]'), { within: 10_000, until: (value) => value.elements.length === 1, label: "visible model chart" });
    expect(modelChart.elements).toHaveLength(1);
    await admin.screenshot();
    await admin.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const layout = await adminProbe.dom("body");
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    await admin.screenshot();
  });

  await step("an organization with no usage has an explicit empty state", async () => {
    await admin.navigate(world.url(`${world.emptyDetailPath}/usage`));
    await admin.see({ testId: "admin-organization-usage" }, { text: /No recorded gateway requests in this period\./ });
    const usage = await adminProbe.dom('[data-testid="admin-organization-usage"]');
    evidence.recordAssertionEvidence("A zero-usage organization has a usable destination and a clear empty state", usage.elements[0]?.text ?? "missing", usage.elements.length === 1);
    expect(usage.elements.length).toBe(1);
    await admin.screenshot();
  });

  await step("the Admin breadcrumb returns to the overview", async () => {
    await admin.click({ testId: "admin-breadcrumb-admin" });
    await admin.see({ role: "heading", label: "Overview" });
    await admin.see({ testId: "admin-breadcrumb-current" }, { text: "Overview" });
    const location = await world.location();
    const ok = location.pathname === "/admin" && location.active === "Overview";
    evidence.recordAssertionEvidence("The breadcrumb root and active navigation agree on the overview", JSON.stringify(location), ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("after: the overview opens on the Control Center, served from cached snapshots", async () => {
    await admin.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    // Recompute now instead of waiting for the background job's first tick.
    await admin.click({ testId: "admin-control-center-refresh" });
    await admin.see({ testId: "admin-control-center-updated" }, { text: /Refreshing every section/ });
    await admin.see({ testId: "admin-control-center-updated" }, { text: /^Updated/, timeoutMs: 90_000 });
    await admin.see({ testId: "admin-control-center-attention" });
    await admin.see({ testId: "admin-control-center-kpis" });
    const view = await world.controlCenter();
    const access = await world.controlCenterAccess();
    const traffic = await world.traffic("admin");
    const computed = Object.values(view.sections).filter((section) => section.computedAt !== null && section.data !== null).length;
    const ok = computed === Object.keys(view.sections).length && view.sections.pulse.data !== null
      && access.read === 403 && access.refresh === 403 && traffic.controlCenter > 0;
    evidence.recordAssertionEvidence("Every Control Center section comes from a snapshot, and only platform admins can read or refresh them",
      `sections with snapshots=${computed}/${Object.keys(view.sections).length}; member read=${access.read}, refresh=${access.refresh}; page reads=${traffic.controlCenter}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("after: the overview shows bounded platform metrics, daily usage and organization links", async () => {
    await admin.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await admin.see({ testId: "admin-dashboard-requests" }, { text: /8/ });
    await admin.see({ testId: "admin-dashboard-cost" }, { text: /101\.00/ });
    await admin.see({ testId: "admin-dashboard-coverage" }, { text: /Price coverage unknown/ });
    const report = await world.dashboard();
    const traffic = await world.traffic("admin");
    const ok = report.daily.length === 30 && report.organizations.length <= 8 && report.activeOrganizations === 2
      && report.totals.requests === 8 && report.totals.tokens === 10269 && report.totals.costMicroUsd === 101000000
      && report.totals.unpricedRequests === null && report.totals.unreportedRequests === null
      && report.daily.reduce((total, day) => total + day.requests, 0) === report.totals.requests && traffic.metrics === 0;
    evidence.recordAssertionEvidence("The dashboard counts both organizations, includes retained and removed-member usage, and defers extra analytics", `totals=${JSON.stringify(report.totals)}; daily=${report.daily.length}; leaders=${report.organizations.length}; extra analytics=${traffic.metrics}`, ok);
    expect(ok).toBe(true);
    expect(await world.dashboardAccess()).toBe(403);
    await admin.screenshot();
    await admin.click({ role: "button", label: "Chart metric" });
    await admin.click({ role: "option", label: "Recorded cost" });
    await admin.see({ testId: "admin-dashboard-chart-costMicroUsd" });
    await admin.click({ role: "link", label: report.organizations[0].name });
    await admin.see({ testId: "admin-organization-insights" });
    await admin.click({ testId: "admin-breadcrumb-admin" });
    await admin.resizeViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await admin.see({ testId: "admin-dashboard-requests" }, { text: /8/ });
    const layout = await adminProbe.dom("body");
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
    await admin.screenshot();
  });

  await step("after: platform active users are counted only when the admin asks", async () => {
    await admin.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await admin.see({ testId: "admin-dashboard-active-users" }, { text: /Count active users/ });
    const before = await world.traffic("admin");
    expect(before.dashboard).toBeGreaterThan(0);
    expect(before.activeUsers).toBe(0);
    await admin.click({ role: "button", label: "Count active users" });
    const expected = await world.activeUsers();
    await admin.see({ testId: "admin-dashboard-active-users" }, { text: new RegExp(`${expected.days7} in 7 days`) });
    const after = await adminProbe.eventually(() => world.traffic("admin"), { within: 10_000, until: (value) => value.activeUsers === 1, label: "requested active-user count" });
    const memberStatus = await world.activeUsersAccess();
    const ok = before.activeUsers === 0 && after.activeUsers === 1 && expected.days30 > 0 && memberStatus === 403;
    evidence.recordAssertionEvidence("Loading the overview no longer scans platform activity",
      `overview loads=${before.dashboard}; active-user counts before asking=${before.activeUsers}, after=${after.activeUsers}; 30-day active users=${expected.days30}; member access=${memberStatus}`, ok);
    expect(ok).toBe(true);
    await admin.screenshot();
  });

  await step("signed-out organization links show sign-in without fetching member or usage data", async () => {
    await anonymous.navigate(world.url(`${world.detailPath}/usage`));
    await anonymous.see({ role: "heading", label: "Sign in required" });
    const traffic = await world.traffic("anonymous");
    const busy = await anonymousProbe.dom('[aria-busy="true"]');
    const ok = traffic.organizationDetail === 0 && traffic.organizationUsage === 0 && busy.elements.length === 0;
    evidence.recordAssertionEvidence("Signed-out visitors cannot trigger organization data or usage aggregation", `detail=${traffic.organizationDetail}; usage=${traffic.organizationUsage}; skeletons=${busy.elements.length}`, ok);
    expect(ok).toBe(true);
    await anonymous.screenshot();
  });

  await step("signed-out organization insights never start aggregation", async () => {
    await anonymous.navigate(world.url(`${world.detailPath}/insights`));
    await anonymous.see({ role: "heading", label: "Sign in required" });
    const traffic = await world.traffic("anonymous");
    expect(traffic.organizationInsights).toBe(0);
    await anonymous.screenshot();
  });

  await step("signed-out organization feature links never load editable flags", async () => {
    await anonymous.navigate(world.url(`${world.detailPath}/features`));
    await anonymous.see({ role: "heading", label: "Sign in required" });
    const traffic = await world.traffic("anonymous");
    const controls = await anonymousProbe.dom('[data-testid^="admin-capability-"], [aria-busy="true"]');
    const ok = traffic.features === 0 && traffic.organizationDetail === 0 && controls.elements.length === 0;
    evidence.recordAssertionEvidence("Signed-out visitors cannot load organization feature data or controls", `feature reads=${traffic.features}; detail reads=${traffic.organizationDetail}; controls=${controls.elements.length}`, ok);
    expect(ok).toBe(true);
    await anonymous.screenshot();
  });

  await step("the signed-out overview never fetches platform analytics", async () => {
    await anonymous.navigate(world.url("/admin"));
    await anonymous.see({ role: "heading", label: "Sign in required" });
    const traffic = await world.traffic("anonymous");
    expect(traffic.dashboard).toBe(0);
    expect(traffic.activeUsers).toBe(0);
    expect(traffic.metrics).toBe(0);
    await anonymous.screenshot();
  });

  await step("a signed-in member without platform access still sees a locked page", async () => {
    await member.navigate(world.url(`${world.detailPath}/features`));
    await member.see({ role: "heading", label: "Admin access required" }, { timeoutMs: 60_000 });
    const access = await world.organizationAccess();
    expect(access).toEqual({ member: 403, memberUsage: 403, memberInsights: 403, memberFeatures: 403, missing: 404, invalid: 400 });
    const controls = await probe.on(world.member).dom('[data-testid^="admin-user-row-"], [data-testid^="admin-capability-"], [aria-busy="true"]');
    evidence.recordAssertionEvidence("A non-admin session never mounts the dashboard", `dashboard rows and skeletons=${controls.elements.length}; endpoint status=${JSON.stringify(access)}`, controls.elements.length === 0);
    expect(controls.elements.length).toBe(0);
    await member.screenshot();
  });
});
