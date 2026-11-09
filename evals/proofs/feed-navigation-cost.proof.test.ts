import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { largeSessionFeed } from "../worlds/large-session-feed.ts";

const test = spec.world(largeSessionFeed, {
  timeout: 900_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

const rows = '[data-sidebar-feed] [data-sidebar-session-id]';
test("Feed navigation mounts a viewport, not every session in a large history", async ({ world, user, probe, step, evidence }) => {
  await step("switch from Workspaces to Feed with 252 sessions", async () => {
    const start = performance.now();
    await user.click({ role: "tab", label: "Feed" });
    await user.see({ testId: `sidebar-session-${world.history.at(-1)?.sessionId}` });
    const mounted = (await probe.dom(rows)).elements.length;
    evidence.recordAssertionEvidence("bounded Feed mount", `${world.history.length + 2} available sessions; ${mounted} mounted rows; switch and readiness probe ${Math.round(performance.now() - start)}ms`, mounted > 0 && mounted < 40);
    expect(mounted).toBeGreaterThan(0);
    expect(mounted).toBeLessThan(40);
    await user.screenshot();
  });

  await step("click a different session without mounting the rest of the history", async () => {
    const target = world.history.at(-2);
    if (!target) throw new Error("Missing arranged session");
    const start = performance.now();
    await user.click({ testId: `sidebar-session-${target.sessionId}` });
    await probe.eventually(() => probe.dom(`[data-session-tab-id="${target.sessionId}"][data-session-tab-active="true"]`), {
      within: 10_000, label: "clicked Feed session becomes selected", until: (snapshot) => snapshot.elements.length === 1,
    });
    const mounted = (await probe.dom(rows)).elements.length;
    evidence.recordAssertionEvidence("bounded navigation work", `${mounted} mounted rows after selection; click and selection probe ${Math.round(performance.now() - start)}ms`, mounted < 40);
    expect(mounted).toBeLessThan(40);
  });

  await step("scroll to the oldest sessions: history remains reachable", async () => {
    const scroller = (await probe.dom('[data-sidebar="content"]')).elements[0];
    if (!scroller) throw new Error("Missing sidebar scroller");
    await user.wheelAt({ x: scroller.rect.left + 100, y: scroller.rect.top + 100, deltaY: 20_000 });
    await user.see({ testId: `sidebar-session-${world.question.sessionId}` });
    const mounted = (await probe.dom(rows)).elements.length;
    evidence.recordAssertionEvidence("oldest history remains available", `oldest session visible; ${mounted} mounted rows at the end`, mounted < 40);
    expect(mounted).toBeLessThan(40);
    await user.click({ testId: `sidebar-session-${world.question.sessionId}` });
    await user.see("composer", { editable: true });
    await user.screenshot();
  });
});
