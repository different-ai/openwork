import { expect } from "vitest";
import { browserScript, spec } from "@openwork/testkit";
import { groupedTaskOrdering, manualTaskOrdering } from "../worlds/manual-task-ordering.ts";
import { nativeDrag as drag } from "../helpers/native-drag.ts";

const test = spec.world(manualTaskOrdering, {
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  timeout: 420_000,
});

test("a workspace member keeps new tasks visible and chooses an order that survives activity and reload", async ({ world, user, probe, agent, step, evidence }) => {
  const row = (id: string) => ({ testId: `sidebar-session-${id}` });
  const list = `[data-sidebar-workspace-id="${world.workspace.workspaceId}"] [data-sidebar-session-id]`;
  // The fixed DOM projection omits attributes; read row identities without
  // mutating the app or relying on activity-dependent accessible labels.
  const ids = () => probe.eval(browserScript((selector) => Array.from(document.querySelectorAll(selector),
    element => element.getAttribute("data-sidebar-session-id") ?? ""), [list]));
  const original = world.sessions.map(session => session.sessionId);
  // appWeb uses history routing rather than the desktop hash router.
  const route = () => probe.eval(browserScript(() => location.pathname + location.hash, []));
  let createdId = "";
  let expected: string[] = [];
  const seeOrder = async (order: string[]) => {
    const observed = await probe.eventually(ids, { within: 10_000, label: "task order", until: value => JSON.stringify(value) === JSON.stringify(order) });
    evidence.recordAssertionEvidence("Tasks keep the chosen order, with the pinned reference outside the workspace list", JSON.stringify({ observed, expected: order, pinned: world.pinned.sessionId }),
      JSON.stringify(observed) === JSON.stringify(order) && !observed.includes(world.pinned.sessionId));
    expect(observed).toEqual(order);
  };

  await step("before: six manually ordered tasks are visible and two are behind Show more", async () => {
    await user.see(row(original[0]!));
    await user.see(row(world.pinned.sessionId));
    await user.see({ text: "Show 2 more" });
    await seeOrder(original.slice(0, 6));
    await user.screenshot();
  });

  await step("the workspace plus opens an empty composer without adding a task", async () => {
    const label = await probe.eval(browserScript((workspaceId) => document.querySelector(
      `[data-sidebar-workspace-id="${workspaceId}"] [data-workspace-new-task]`)?.getAttribute("aria-label"), [world.workspace.workspaceId]));
    if (!label) throw new Error("Workspace new-task action is missing");
    await user.hover({ role: "button", label: label.split(" · ")[1]! });
    await user.see({ role: "button", label });
    await user.click({ role: "button", label });
    await user.see("composer", { editable: true, text: "" });
    await user.type("composer", world.prompt, { verify: true });
    await seeOrder(original.slice(0, 6));
    const expectedInventory = [...original, world.pinned.sessionId].sort();
    const inventory = await probe.eventually(async () => (await agent.list()).map(session => session.sessionId).sort(), {
      within: 10_000, label: "complete inventory after opening a draft",
      until: value => JSON.stringify(value) === JSON.stringify(expectedInventory),
    });
    expect(inventory).toEqual(expectedInventory);
    evidence.recordAssertionEvidence("Opening and typing a new task creates no session, including beyond Show more", JSON.stringify(inventory), true);
    await user.screenshot();
  });

  await step("after: sending the first prompt places the new task above the saved order", async () => {
    await user.press("Enter");
    await user.see({ text: world.reply }, { timeoutMs: 90_000 });
    const hash = await route();
    createdId = hash.split("/session/")[1]?.split(/[/?#]/)[0] ?? "";
    expect(createdId).not.toBe("");
    await user.screenshot();
    await seeOrder([createdId, ...original.slice(0, 5)]);
    await user.see(row(world.pinned.sessionId));
  });

  await step("a member drags a task above its neighbor without opening it", async () => {
    const source = original[2]!;
    const target = original[0]!;
    await user.hover(row(source));
    const sourceBox = (await probe.dom(`[data-testid="sidebar-session-${source}"]`)).elements[0]?.rect;
    const targetBox = (await probe.dom(`[data-testid="sidebar-session-${target}"]`)).elements[0]?.rect;
    if (!sourceBox || !targetBox) throw new Error("Missing drag targets");
    await drag(world.app, { x: sourceBox.left + sourceBox.width / 2, y: sourceBox.top + sourceBox.height / 2 },
      { x: targetBox.left + targetBox.width / 2, y: targetBox.top + 4 }, () => user.screenshot());
    expected = [createdId, source, original[0]!, original[1]!, ...original.slice(3)];
    await seeOrder(expected.slice(0, 6));
    expect(await route()).toContain(createdId);
    await user.screenshot();
  });

  await step("reload preserves the order and Show more reveals the untouched hidden tasks", async () => {
    await user.reload();
    await user.see(row(createdId));
    await seeOrder(expected.slice(0, 6));
    await user.click({ text: "Show 3 more" });
    await seeOrder(expected);
    await user.screenshot();
  });

  await step("command-palette creation also waits for first send and inserts at the top", async () => {
    const mac = await probe.eval(browserScript(() => /Mac/i.test(navigator.platform), []));
    await user.press(mac ? "Meta+K" : "Control+K");
    await user.see({ placeholder: "Search actions and settings…" });
    await user.type({ placeholder: "Search actions and settings…" }, "New session");
    await user.click({ role: "option", label: /^New session/ });
    await user.see("composer", { editable: true, text: "" });
    await seeOrder(expected);
    await user.type("composer", world.prompt, { verify: true });
    await user.press("Enter");
    await user.see({ text: world.reply }, { timeoutMs: 90_000 });
    const paletteId = (await route()).split("/session/")[1]?.split(/[/?#]/)[0] ?? "";
    expect(paletteId).not.toBe(createdId);
    expect(paletteId).not.toBe("");
    // An expanded list keeps its current limit; the new task is still first.
    const limit = expected.length;
    expected = [paletteId, ...expected];
    await seeOrder(expected.slice(0, limit));
    const stored = await probe.storage("openwork.react.sessionManagement");
    expect(stored).toMatchObject({ state: { orderByWorkspace: {
      [world.otherWorkspace.workspaceId]: world.otherSessions.map(session => session.sessionId),
    } } });
    await user.screenshot();
  });

  await step("viewing and sending in an older task leaves its position unchanged", async () => {
    // Continue a conversation created through the actual first-send boundary,
    // rather than an empty legacy session used only to arrange the list.
    await user.click(row(createdId));
    await probe.eventually(route, { within: 10_000, label: "older task selected", until: value => value.includes(createdId) });
    await user.see({ text: world.reply });
    await user.type("composer", world.followup, { verify: true });
    await user.press("Enter");
    await user.see({ text: world.followupReply }, { timeoutMs: 90_000 });
    await seeOrder(expected.slice(0, 9));
    await user.screenshot();
  });

  await step("pinned tasks can be reordered independently and unpinning restores workspace order", async () => {
    const pinnedId = original[0]!;
    await user.rightClick(row(pinnedId));
    await user.click({ role: "menuitem", label: "Pin session" });
    await user.hover(row(pinnedId));
    const from = (await probe.dom(`[data-testid="sidebar-session-${pinnedId}"]`)).elements[0]!.rect;
    const to = (await probe.dom(`[data-testid="sidebar-session-${world.pinned.sessionId}"]`)).elements[0]!.rect;
    await drag(world.app, { x: from.left + from.width / 2, y: from.top + from.height / 2 },
      { x: to.left + to.width / 2, y: to.top + 4 });
    await probe.eventually(() => probe.storage("openwork.react.sessionManagement"), { within: 10_000, label: "pin order saved",
      until: value => JSON.stringify(value).includes(`"pinnedIds":["${pinnedId}","${world.pinned.sessionId}"]`) });
    await user.reload();
    await user.see(row(pinnedId));
    // Read-only identity observation for the global section, separate from the workspace order.
    const pins = await probe.eval(browserScript(() => Array.from(document.querySelectorAll("[data-global-pinned-sessions] [data-sidebar-session-id]"),
      element => element.getAttribute("data-sidebar-session-id")), []));
    expect(pins).toEqual([pinnedId, world.pinned.sessionId]);
    await user.screenshot();
    await user.rightClick(row(pinnedId));
    await user.click({ role: "menuitem", label: "Unpin session" });
    await seeOrder(expected.slice(0, 6));
  });
});

const groupedTest = spec.world(groupedTaskOrdering, {
  resources: { surfaces: ["appWeb"], services: ["mock"] }, timeout: 420_000,
});

groupedTest("a workspace member orders grouped tasks without disturbing other groups or workspaces", async ({ world, user, probe, agent, step, evidence }) => {
  const row = (id: string) => ({ testId: `sidebar-session-${id}` });
  const original = world.sessions.map(session => session.sessionId);
  const route = () => probe.eval(browserScript(() => location.pathname + location.hash, []));
  // Read-only identity observation; readDom intentionally omits attributes.
  const ids = () => probe.eval(browserScript((workspaceId) => Array.from(document.querySelectorAll(
    `[data-sidebar-workspace-id="${workspaceId}"] [data-sidebar-session-id]`), element => element.getAttribute("data-sidebar-session-id")), [world.workspace.workspaceId]));
  const seeOrder = async (expected: string[]) => {
    const observed = await probe.eventually(ids, { within: 10_000, label: "group task order",
      until: observed => JSON.stringify(observed) === JSON.stringify(expected) });
    evidence.recordAssertionEvidence("The group's tasks retain the chosen order without including its pinned reference",
      JSON.stringify({ observed, expected, pinned: world.pinned.sessionId }),
      JSON.stringify(observed) === JSON.stringify(expected) && !observed.includes(world.pinned.sessionId));
    expect(observed).toEqual(expected);
  };
  let createdId = "";
  let expected: string[] = [];

  await step("before: the named group contains six visible tasks and two hidden tasks", async () => {
    await user.see({ text: "Planned tasks" });
    await user.see(row(original[0]!));
    await seeOrder(original.slice(0, 6));
    await user.screenshot();
  });

  await step("after: a first send in the group is visible above its saved order", async () => {
    await user.hover({ role: "button", label: /^Planned tasks/ });
    await user.see({ role: "button", label: "Group actions", nth: 0 });
    await user.hover({ role: "button", label: "Group actions", nth: 0 });
    await user.click({ role: "button", label: "New session in group" });
    await user.see("composer", { editable: true, text: "" });
    await user.type("composer", world.prompt, { verify: true });
    await seeOrder(original.slice(0, 6));
    const expectedInventory = [...original, world.pinned.sessionId].sort();
    const inventory = await probe.eventually(async () => (await agent.list()).map(session => session.sessionId).sort(), {
      within: 10_000, label: "complete inventory after opening a grouped draft",
      until: value => JSON.stringify(value) === JSON.stringify(expectedInventory),
    });
    expect(inventory).toEqual(expectedInventory);
    await user.press("Enter");
    await user.see({ text: world.reply }, { timeoutMs: 90_000 });
    createdId = (await route()).split("/session/")[1]?.split(/[/?#]/)[0] ?? "";
    expect(createdId).not.toBe("");
    await user.screenshot();
    await seeOrder([createdId, ...original.slice(0, 5)]);
    await user.screenshot();
  });

  await step("dragging within the group preserves hidden tasks and survives reload", async () => {
    await user.hover(row(original[2]!));
    const from = (await probe.dom(`[data-testid="sidebar-session-${original[2]}"]`)).elements[0]!.rect;
    const to = (await probe.dom(`[data-testid="sidebar-session-${original[0]}"]`)).elements[0]!.rect;
    await drag(world.app, { x: from.left + from.width / 2, y: from.top + from.height / 2 },
      { x: to.left + to.width / 2, y: to.top + 4 });
    expected = [createdId, original[2]!, original[0]!, original[1]!, ...original.slice(3)];
    await seeOrder(expected.slice(0, 6));
    expect(await route()).toContain(createdId);
    await user.reload();
    await user.see(row(createdId));
    await user.click({ text: "Show 3 more" });
    await seeOrder(expected);
    await user.screenshot();
  });

  await step("dropping on another group moves only the intended task", async () => {
    await user.hover(row(original[0]!));
    const from = (await probe.dom(`[data-testid="sidebar-session-${original[0]}"]`)).elements[0]!.rect;
    const to = (await probe.dom('[data-session-group="grp_other"]')).elements[0]!.rect;
    await drag(world.app, { x: from.left + from.width / 2, y: from.top + from.height / 2 },
      { x: to.left + to.width / 2, y: to.top + to.height / 2 });
    const stored = await probe.eventually(() => probe.storage("openwork.react.sessionManagement"), {
      within: 10_000, label: "group assignment persisted", until: value => JSON.stringify(value).includes(`"${original[0]}":"grp_other"`),
    });
    expect(stored).toMatchObject({ state: { pinnedIds: [world.pinned.sessionId], orderByWorkspace: {
      [world.otherWorkspace.workspaceId]: world.otherSessions.map(session => session.sessionId),
    }, groupsByWorkspace: { [world.workspace.workspaceId]: { assignments: {
      [original[0]!]: "grp_other", [original[1]!]: "grp_tasks", [createdId]: "grp_tasks",
    } } } } });
    await seeOrder([...expected.filter(id => id !== original[0]), original[0]!]);
    evidence.recordAssertionEvidence("Moving one task changes only its group, preserving pins and the other workspace's order", JSON.stringify(stored), true);
    await user.screenshot();
  });
});
