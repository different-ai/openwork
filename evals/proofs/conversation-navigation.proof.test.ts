import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { conversationNavigation } from "../worlds/conversation-navigation.ts";

const test = spec.world(conversationNavigation, {
  timeout: 300_000,
  resources: { surfaces: ["desktop"], services: ["mock"], nativeReason: "The titlebar back and forward controls must navigate real Electron conversations." },
});

test("a member can retrace sidebar and chat-link visits across workspaces without duplicate stops", async ({ world, user, probe, step, evidence }) => {
  const routeA = `#${world.route(world.one.workspaceId, world.a.sessionId)}`;
  const routeB = `#${world.route(world.one.workspaceId, world.b.sessionId)}`;
  const routeC = `#${world.route(world.one.workspaceId, world.c.sessionId)}`;
  const routeD = `#${world.route(world.two.workspaceId, world.d.sessionId)}`;
  const states: { label: string; route: string; back: boolean; forward: boolean }[] = [];
  const state = async (label: string) => {
    const value = { label, route: await probe.hash(),
      back: (await probe.dom('[data-conversation-history-control="back"]:not(:disabled)')).elements.length > 0,
      forward: (await probe.dom('[data-conversation-history-control="forward"]:not(:disabled)')).elements.length > 0 };
    return value;
  };
  const current = async (route: string) => {
    await probe.eventually(() => probe.hash(), { within: 15_000, until: value => value === route, label: "selected workspace and conversation" });
    const sessionId = route.split("/").at(-1);
    await probe.eventually(() => probe.dom(`[data-workbench-pane="primary"] [data-session-surface-id="${sessionId}"]`), {
      within: 15_000, until: value => value.elements.some(element => element.rect.width > 0 && element.rect.height > 0),
      label: "the selected conversation is rendered in the primary pane",
    });
    expect((await probe.dom(`[data-session-tab-id="${sessionId}"][data-session-tab-active="true"]`)).elements).toHaveLength(1);
    expect((await probe.dom('[data-session-tab-active="true"]')).elements).toHaveLength(1);
  };
  const start = async () => {
    await user.click({ testId: `sidebar-session-${world.a.sessionId}` });
    await current(routeA);
    await user.reload();
    await user.see({ role: "link", label: "Open task: Navigation B" }, { timeoutMs: 30_000 });
    await current(routeA);
  };
  const arrows = async (label: string, expectedBack: boolean, expectedForward: boolean) => {
    // Route selection precedes the history effect. Observe the settled controls,
    // but retain the last real state when they never reach the expected ends.
    let observed = await state(label);
    await probe.eventually(async () => { observed = await state(label); return observed; }, {
      within: 3000, label: `${label} settled controls`,
      until: value => value.back === expectedBack && value.forward === expectedForward,
    }).catch(() => undefined);
    states.push(observed);
    expect.soft(observed.back, `${label}: back`).toBe(expectedBack);
    expect.soft(observed.forward, `${label}: forward`).toBe(expectedForward);
    return observed;
  };
  const traverse = async (direction: "back" | "forward", expected: string) => {
    const available = (await state(`before ${direction}`))[direction];
    if (available) await user.click({ label: `${direction === "back" ? "Back" : "Forward"} in conversation history` });
    // A disabled arrow is a recorded product failure, not a harness click timeout.
    if (available) await current(expected);
    expect.soft(await probe.hash(), `${direction} destination`).toBe(expected);
  };

  await step("sidebar visits A, B and C retrace B and C with arrows enabled only where a visit exists", async () => {
    await start();
    await arrows("A initial", false, false);
    await user.click({ testId: `sidebar-session-${world.b.sessionId}` }); await current(routeB);
    await arrows("B sidebar", true, false);
    await user.click({ testId: `sidebar-session-${world.c.sessionId}` }); await current(routeC);
    await arrows("C sidebar", true, false);
    await traverse("back", routeB); await arrows("B back", true, true);
    await traverse("forward", routeC); await arrows("C forward", true, false);
    evidence.recordAssertionEvidence("Sidebar traversal", JSON.stringify(states), states.every(s => s.label !== "C forward" || s.route === routeC && s.back && !s.forward));
    await user.screenshot();
  });
  await step("a chat link from A to B adds one visit and both arrows return to the right conversation", async () => {
    await start();
    await user.click({ role: "link", label: "Open task: Navigation B" }); await current(routeB);
    await arrows("B chat link", true, false);
    await traverse("back", routeA); await arrows("A link back", false, true);
    await traverse("forward", routeB); await arrows("B link forward", true, false);
    evidence.recordAssertionEvidence("Same-workspace chat link", JSON.stringify(states.slice(-7)), (await probe.hash()) === routeB);
    await user.screenshot();
  });
  await step("a chat link into another workspace retains A as the previous visit and D as the next", async () => {
    await start();
    await user.click({ role: "link", label: "Open task: Navigation D" }); await current(routeD);
    const destination = await arrows("D cross-workspace link", true, false);
    await user.screenshot();
    await traverse("back", routeA); await arrows("A cross-workspace back", false, true);
    await traverse("forward", routeD); await arrows("D cross-workspace forward", true, false);
    evidence.recordAssertionEvidence("Cross-workspace chat link", JSON.stringify(states.slice(-7)), destination.back && (await probe.hash()) === routeD);
    await user.screenshot();
  });
  await step("clicking A's own chat link adds no duplicate visit and preserves the forward branch", async () => {
    await start();
    await user.click({ role: "link", label: "Open task: Navigation A" }); await current(routeA);
    await arrows("same-session initial", false, false);
    await user.click({ testId: `sidebar-session-${world.b.sessionId}` }); await current(routeB);
    await arrows("B before same-session check", true, false);
    await traverse("back", routeA);
    await user.click({ role: "link", label: "Open task: Navigation A" }); await current(routeA);
    const same = await arrows("same-session after back", false, true);
    await traverse("forward", routeB);
    evidence.recordAssertionEvidence("No duplicate same-session visit", JSON.stringify(states.slice(-6)), !same.back && same.forward && (await probe.hash()) === routeB);
    await user.screenshot();
  });
});
