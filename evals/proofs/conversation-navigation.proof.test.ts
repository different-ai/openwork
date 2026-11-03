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

  const capture = async (expected: { route: string; sessionId: string; title: string; workspaceId: string; workspaceTitle: string; back: boolean; forward: boolean }) => {
    await current(expected.route);
    await arrows(`${expected.title} capture`, expected.back, expected.forward);
    const viewport = (await probe.dom("html")).elements[0]?.rect;
    if (!viewport) throw new Error("The capture has no document bounds");
    const visible = (elements: Awaited<ReturnType<typeof probe.dom>>["elements"]) => elements.some(element =>
      element.rect.width > 0 && element.rect.height > 0 && element.rect.left >= 0 && element.rect.top >= 0
      && element.rect.right <= viewport.right && element.rect.bottom <= viewport.bottom);
    const read = async () => ({
      route: await probe.hash(),
      title: (await probe.dom("[data-session-header-title]")).elements.filter(element => visible([element])).map(element => element.text).join(""),
      workspace: visible((await probe.dom(`[data-session-header-workspace="${expected.workspaceTitle}"]`)).elements),
      selected: (await probe.dom(`[data-sidebar-session-workspace-id="${expected.workspaceId}"] [data-session-tab-id="${expected.sessionId}"][data-session-tab-active="true"]`)).elements.filter(element => visible([element])).length,
      activeRows: (await probe.dom('[data-session-tab-active="true"]')).elements.length,
      mainPane: visible((await probe.dom(`[data-workbench-pane="primary"] [data-session-surface-id="${expected.sessionId}"]`)).elements),
      back: (await probe.dom(`[data-conversation-history-control="back"]${expected.back ? ":not(:disabled)" : ":disabled"}`)).elements.filter(element => visible([element])).length,
      forward: (await probe.dom(`[data-conversation-history-control="forward"]${expected.forward ? ":not(:disabled)" : ":disabled"}`)).elements.filter(element => visible([element])).length,
    });
    const before = await read();
    const image = await user.screenshot();
    const after = await read();
    // Supported hash-bound validation, using measured DOM state and the capture's
    // own route/text metadata. This is not an independent pixel/vision judgment.
    // Check both sides of capture so a navigation race cannot grade the wrong image.
    const snapshots = [before, after];
    const text = image.viewportText ?? "";
    const results = [
      { expectation: `${expected.title} is selected in ${expected.workspaceTitle}; Back is ${expected.back ? "enabled" : "disabled"} and Forward is ${expected.forward ? "enabled" : "disabled"}.`,
        passed: snapshots.every(value => value.title === expected.title && value.workspace && value.back === 1 && value.forward === 1) && text.includes(expected.title) && text.includes(expected.workspaceTitle),
        evidence: `Visible title/workspace and native disabled selectors before/after capture: ${JSON.stringify(snapshots)}.` },
      { expectation: `Exactly one sidebar row is selected: ${expected.title} in ${expected.workspaceTitle}, and its conversation occupies the primary pane.`,
        passed: snapshots.every(value => value.selected === 1 && value.activeRows === 1 && value.mainPane),
        evidence: `Workspace/session-scoped selected rows, all active rows, visible primary pane: ${JSON.stringify(snapshots.map(value => ({ selected: value.selected, activeRows: value.activeRows, mainPane: value.mainPane })))}.` },
      { expectation: `The capture metadata and route before/after capture equal ${expected.route}.`,
        passed: image.route === expected.route && snapshots.every(value => value.route === expected.route),
        evidence: `Before=${before.route}; capture=${image.route}; after=${after.route}; screenshot SHA-256=${image.hash}.` },
    ];
    const ok = results.every(result => result.passed);
    evidence.recordVisualValidation(image.hash, {
      ok, results, description: `DOM-backed capture validation of ${expected.title} in ${expected.workspaceTitle}. No pixel-vision grade is claimed.`,
      why: results.filter(result => !result.passed).map(result => result.expectation).join(" "),
      model: "DOM assertions + capture metadata (no vision model)", cached: false,
    });
    expect(results.filter(result => !result.passed)).toEqual([]);
  };
  const shotA = { route: routeA, sessionId: world.a.sessionId, title: world.a.title, workspaceId: world.one.workspaceId, workspaceTitle: "Navigation One" };
  const shotB = { route: routeB, sessionId: world.b.sessionId, title: world.b.title, workspaceId: world.one.workspaceId, workspaceTitle: "Navigation One" };
  const shotC = { route: routeC, sessionId: world.c.sessionId, title: world.c.title, workspaceId: world.one.workspaceId, workspaceTitle: "Navigation One" };
  const shotD = { route: routeD, sessionId: world.d.sessionId, title: world.d.title, workspaceId: world.two.workspaceId, workspaceTitle: "Navigation Two" };

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
    await capture({ ...shotC, back: true, forward: false });
  });
  await step("a chat link from A to B adds one visit and both arrows return to the right conversation", async () => {
    await start();
    await user.click({ role: "link", label: "Open task: Navigation B" }); await current(routeB);
    await arrows("B chat link", true, false);
    await traverse("back", routeA); await arrows("A link back", false, true);
    await traverse("forward", routeB); await arrows("B link forward", true, false);
    evidence.recordAssertionEvidence("Same-workspace chat link", JSON.stringify(states.slice(-7)), (await probe.hash()) === routeB);
    await capture({ ...shotB, back: true, forward: false });
  });
  await step("a chat link into another workspace retains A as the previous visit and D as the next", async () => {
    await start();
    await capture({ ...shotA, back: false, forward: false });
    await user.click({ role: "link", label: "Open task: Navigation D" }); await current(routeD);
    const destination = await arrows("D cross-workspace link", true, false);
    await capture({ ...shotD, back: true, forward: false });
    await traverse("back", routeA); await arrows("A cross-workspace back", false, true);
    await traverse("forward", routeD); await arrows("D cross-workspace forward", true, false);
    evidence.recordAssertionEvidence("Cross-workspace chat link", JSON.stringify(states.slice(-7)), destination.back && (await probe.hash()) === routeD);
    // D was already captured on arrival; a second identical image adds no proof.
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
    await capture({ ...shotA, back: false, forward: true });
    await traverse("forward", routeB);
    evidence.recordAssertionEvidence("No duplicate same-session visit", JSON.stringify(states.slice(-6)), !same.back && same.forward && (await probe.hash()) === routeB);
  });
});
