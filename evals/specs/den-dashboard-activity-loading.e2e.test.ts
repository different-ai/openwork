import { expect } from "vitest";
import { eventually, spec } from "@openwork/testkit";
import { denDashboardActivityLoading } from "../worlds/den-dashboard-activity.ts";
import { activityApiTimings, activityTiming } from "../worlds/den-dashboard-activity-timing.ts";

const test = spec.world(denDashboardActivityLoading, {
  timeout: 600_000,
  resources: { surfaces: ["web"], services: ["den", "mock"] },
});

test("an owner opens a populated workspace without reading every skill's history", async ({ world, user, probe, step, evidence }) => {
  const owner = user.on(world.web);
  const page = probe.on(world.web);
  const sample = await activityTiming(world.web);
  const rows = '[data-testid="dashboard-activity-row"]';
  const verifyRows = async () => {
    expect((await page.dom(`${rows} p:first-child`)).elements.map((entry) => entry.text))
      .toEqual(world.performanceEvents.map((entry) => entry.title));
    for (const [index, event] of world.performanceEvents.entries()) {
      expect((await page.dom(`${rows}:nth-child(${index + 1}) time[data-activity-time][datetime="${event.createdAt}"]`)).elements).toHaveLength(1);
      expect((await page.dom(`${rows}:nth-child(${index + 1}) a[href="${event.href}"]`)).elements).toHaveLength(1);
    }
  };
  let bounded = false;
  let warmRowsRetained = false;
  let resolvedReads = 0;
  let attachmentReads = 0;
  const isAttachment = (route: string) => route.includes("/marketplaces/") && route.endsWith("/plugins");

  await step("the owner opens a workspace with twelve handbooks and ninety-six added skills", async () => {
    await owner.see({ testId: "workspace-switcher-trigger" }, { timeoutMs: 60_000 });
    await owner.click({ testId: "workspace-switcher-trigger" });
    await owner.click({ role: "button", label: new RegExp(`^${world.names.otherWorkspace}`) });
    // Switching routes to the dashboard itself. Do not interrupt that async
    // selection with a separate navigation into the previous organization.
    await owner.see({ testId: "workspace-switcher-trigger" }, { text: new RegExp(world.names.otherWorkspace), timeoutMs: 60_000 });
    await owner.see({ testId: "dashboard-activity-row" }, { timeoutMs: 90_000 });
    await verifyRows();
    evidence.recordAssertionEvidence("the newest five match Den's stored versions", "All five titles, destinations, and exact version timestamps match the persisted fixture, sorted by date and event ID.", true);
    await owner.screenshot();
  });

  await step("after: a cold reload reads only histories that can reach the newest five", async () => {
    const previous = await sample();
    const logOffset = (await world.den.apiLog()).length;
    await owner.reload();
    // readyState alone can still describe the outgoing document after reload.
    await eventually(async () => (await sample()).timeOrigin !== previous.timeOrigin, { within: 30_000, label: "a new browser document" });
    await owner.see({ testId: "dashboard-activity-row" }, { timeoutMs: 90_000 });
    await owner.notSee({ testId: "dashboard-activity-loading" });
    await verifyRows();
    const timing = { ...await sample(), serverRequests: activityApiTimings((await world.den.apiLog()).slice(logOffset)) };
    const serverVersions = timing.serverRequests.filter((entry) => entry.route.endsWith("/versions"));
    expect(serverVersions.length).toBeGreaterThan(0);
    expect(serverVersions.every((entry) => entry.status === 200)).toBe(true);
    expect(serverVersions).toHaveLength(timing.versionReads);
    resolvedReads = timing.requests.filter((entry) => entry.route.endsWith("/resolved")).length;
    attachmentReads = timing.requests.filter((entry) => isAttachment(entry.route)).length;
    // Timestamp ties remain candidates. Allow two whole handbooks, never a
    // scan of all 96 added histories. The deterministic unit loop owns latency
    // assertions; these are real DOM durations, not universal network budgets.
    bounded = timing.versionReads > 0 && timing.versionReads <= 16;
    console.info("Activity cold load", JSON.stringify(timing));
    evidence.recordAssertionEvidence("cold Activity avoids the full history scan", JSON.stringify(timing), bounded);
    await owner.screenshot();
    expect(timing.loadingMs).not.toBeNull();
  });

  await step("a warm return keeps the same real rows visible while refreshing", async () => {
    await owner.click({ testId: "workspace-switcher-trigger" });
    await owner.click({ role: "button", label: new RegExp(`^${world.names.workspace}`) });
    await owner.see({ text: "Nothing new" }, { timeoutMs: 30_000 });
    const before = await sample();
    await owner.click({ testId: "workspace-switcher-trigger" });
    await owner.click({ role: "button", label: new RegExp(`^${world.names.otherWorkspace}`) });
    await owner.see({ testId: "dashboard-activity-row" }, { timeoutMs: 30_000 });
    await verifyRows();
    await eventually(async () => {
      const refresh = (await sample()).requests.filter((entry) => entry.startMs >= before.observedAtMs);
      return refresh.filter((entry) => entry.route.endsWith("/resolved")).length >= resolvedReads
        && refresh.filter((entry) => isAttachment(entry.route)).length >= attachmentReads;
    }, { within: 30_000, label: "the warm return to reread authorized contents" });
    const after = await sample();
    expect(after.timeOrigin).toBe(before.timeOrigin);
    const requests = after.requests.filter((entry) => entry.startMs >= before.observedAtMs);
    const loadingStarts = after.loadingStarts.filter((time) => time >= before.observedAtMs);
    warmRowsRetained = loadingStarts.length === 0;
    await verifyRows();
    // This observes continuity through the content reread, not network idle.
    // Completed Resource Timing entries cannot prove no request is in flight;
    // full-refresh version-cache reuse is asserted by the deterministic loader test.
    const timing = { loadingStarts, observedThroughMs: after.observedAtMs - before.observedAtMs, requests };
    console.info("Activity warm return", JSON.stringify(timing));
    evidence.recordAssertionEvidence("cached rows stay visible during the warm content refresh", JSON.stringify(timing), warmRowsRetained);
    await owner.screenshot();
  });
  // Keep the warm control observable even in an intentionally red baseline.
  expect(bounded).toBe(true);
  expect(warmRowsRetained).toBe(true);
});
