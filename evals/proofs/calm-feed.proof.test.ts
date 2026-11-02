import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { calmFeed } from "../worlds/calm-feed.ts";

const test = spec.world(calmFeed, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };
const row = (id: string) => `[data-sidebar-session-id="${id}"]`;
const round = (rect: Rect) => ({ x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) });
const describe = (rect: Rect) => { const { x, y, w, h } = round(rect); return `${w}×${h} at ${x},${y}`; };

test("a member on the Feed sees calm rows that never move and still knows which task waits on a decision", async ({ world, user, probe, step, evidence }) => {
  const { question, resting } = world;

  const one = async (selector: string): Promise<Rect> => {
    const { elements } = await probe.dom(selector);
    expect(elements, selector).toHaveLength(1);
    const element = elements[0];
    if (!element) throw new Error(`Missing ${selector}`);
    return element.rect;
  };
  // Every lane of one Feed row: the row, its status dot, title, shortcut lane,
  // workspace line, decision word and the More menu's reserved slot.
  const lanes = async (id: string) => ({
    row: await one(`${row(id)} [data-session-tab-id]`),
    indicator: await one(`${row(id)} [data-session-tab-id] > span:first-child`),
    title: await one(`${row(id)} [data-session-title-slot]`),
    shortcut: await one(`${row(id)} [data-session-action-slot="number-shortcut"]`),
    subtitle: await one(`${row(id)} [data-session-feed-subtitle]`),
    decision: await one(`${row(id)} [data-session-decision]`),
    menuSlot: await one(`${row(id)} [data-session-action-slot="menu"]`),
  });
  type Lanes = Awaited<ReturnType<typeof lanes>>;
  const laneNames = ["row", "indicator", "title", "shortcut", "subtitle", "decision", "menuSlot"] satisfies (keyof Lanes)[];
  const moved = (rest: Lanes, now: Lanes) => laneNames
    .filter((lane) => JSON.stringify(round(rest[lane])) !== JSON.stringify(round(now[lane])))
    .map((lane) => `${lane} ${describe(rest[lane])} → ${describe(now[lane])}`);
  const tabSelected = async (view: "workspaces" | "feed") =>
    (await probe.dom(`[data-sidebar-view="${view}"][aria-selected="true"]`)).elements.length === 1;

  await step("before: a fresh profile opens the sidebar on Workspaces, with Feed one tab away", async () => {
    await user.see({ role: "tab", label: "Workspaces" });
    await user.see({ role: "tab", label: "Feed" });
    const workspacesFirst = await tabSelected("workspaces");
    const feedFirst = await tabSelected("feed");
    evidence.recordAssertionEvidence("fresh profile default view", `Workspaces selected: ${workspacesFirst}; Feed selected: ${feedFirst}`, workspacesFirst && !feedFirst);
    expect(workspacesFirst).toBe(true);
    expect(feedFirst).toBe(false);
    await user.screenshot();
  });

  await step("the member switches to Feed and it is still chosen after a reload", async () => {
    await user.click({ role: "tab", label: "Feed" });
    await probe.eventually(() => tabSelected("feed"), { within: 10_000, label: "Feed tab selected", until: Boolean });
    await user.reload();
    await user.see({ role: "tab", label: "Feed" }, { timeoutMs: 60_000 });
    const kept = await probe.eventually(() => tabSelected("feed"), { within: 30_000, label: "Feed tab kept after reload", until: Boolean });
    await user.see({ testId: `sidebar-session-${resting.sessionId}` }, { timeoutMs: 60_000 });
    evidence.recordAssertionEvidence("Feed kept after reload", `Feed tab selected after reload: ${kept}`, kept);
    expect(kept).toBe(true);
  });

  await step("given: one task asks a question and another finishes", async () => {
    const run = async (id: string, prompt: string) => {
      await user.click({ testId: `sidebar-session-${id}` });
      await user.see("composer", { editable: true, timeoutMs: 60_000 });
      await user.type("composer", prompt, { verify: true });
      await probe.eventually(() => probe.composer(), { within: 30_000, label: "the engine admits the request", until: (state) => state.runTaskEnabled });
      await user.click("Run task");
    };
    await run(question.sessionId, question.prompt);
    await user.see({ text: question.question }, { timeoutMs: 90_000 });
    // Finished last, so it is the newest activity in the Feed.
    await run(resting.sessionId, resting.prompt);
    await user.see({ text: resting.reply }, { timeoutMs: 90_000 });
    const decisions = await probe.eventually(async () => ({
      question: (await probe.dom(`${row(question.sessionId)} [data-session-decision]`)).elements.map((element) => element.text),
      resting: (await probe.dom(`${row(resting.sessionId)} [data-session-decision]`)).elements.map((element) => element.text),
    }), { within: 60_000, label: "the waiting row names its decision", until: (value) => value.question.length === 1 });
    evidence.recordAssertionEvidence("decision words", `question row says ${JSON.stringify(decisions.question)}; finished row says ${JSON.stringify(decisions.resting)}`,
      decisions.question[0] === "Question" && decisions.resting.length === 0);
    expect(decisions).toEqual({ question: ["Question"], resting: [] });
  });

  await step("after: the waiting task stays in its place under Today and says Question quietly, with no Needs you section", async () => {
    await user.hover({ role: "tab", label: "Feed" });
    await user.notSee({ text: "Needs you" });
    const needsYouSections = (await probe.dom('[data-sidebar-feed-section="needs-you"]')).elements.length;
    const today = await probe.dom('[data-sidebar-feed-section="today"] [data-sidebar-session-id]');
    const order = await Promise.all([resting, question].map(async (task) => ({ title: task.title, top: (await one(row(task.sessionId))).top })));
    order.sort((a, b) => a.top - b.top);
    const inToday = today.elements.length;
    const newestFirst = order[0]?.title === resting.title;
    evidence.recordAssertionEvidence("Feed order", `Needs you sections: ${needsYouSections}; rows under Today: ${inToday}; top to bottom: ${order.map((entry) => entry.title).join(" → ")}`,
      needsYouSections === 0 && inToday === 2 && newestFirst);
    expect(needsYouSections).toBe(0);
    expect(inToday).toBe(2);
    // The finished task ran last; the waiting task is not lifted above it.
    expect(order[0]?.title).toBe(resting.title);
    await user.screenshot();
  });

  const rest = await step("a waiting row at rest: status dot, title, shortcut lane, decision word and menu slot each have a fixed place", async () => {
    await user.hover({ role: "tab", label: "Feed" });
    const measured = await lanes(question.sessionId);
    const fullWidthTitle = Math.abs(measured.title.width - measured.subtitle.width) <= 1;
    const shortcutBelowTitle = measured.shortcut.top >= measured.title.bottom - 1;
    const ok = Math.round(measured.row.height) === 48 && measured.menuSlot.width >= 20 && fullWidthTitle && shortcutBelowTitle;
    evidence.recordAssertionEvidence("row lanes at rest", `row ${describe(measured.row)}; full-width title ${describe(measured.title)}; second-line shortcut lane ${describe(measured.shortcut)}; decision ${describe(measured.decision)}; menu slot ${describe(measured.menuSlot)}`, ok);
    expect(Math.round(measured.row.height)).toBe(48);
    expect(measured.menuSlot.width).toBeGreaterThanOrEqual(20);
    expect(fullWidthTitle).toBe(true);
    expect(shortcutBelowTitle).toBe(true);
    return measured;
  });

  await step("on hover the More menu appears in its reserved slot and nothing in the row moves", async () => {
    await user.hover({ testId: `sidebar-session-${question.sessionId}` });
    const now = await lanes(question.sessionId);
    const menu = await one(`[data-testid="session-actions-${question.sessionId}"]`);
    const shifts = moved(rest, now);
    const inSlot = Math.abs(menu.left - now.menuSlot.left) <= 2 && Math.abs(menu.right - now.menuSlot.right) <= 2;
    evidence.recordAssertionEvidence("hover keeps every lane", `moved: ${shifts.length ? shifts.join("; ") : "nothing"}; More menu ${describe(menu)} over its slot ${describe(now.menuSlot)}`, shifts.length === 0 && inSlot);
    expect(shifts).toEqual([]);
    expect(inSlot).toBe(true);
    await user.screenshot();
  });

  await step("keyboard focus reaches the row's More menu without moving the row", async () => {
    await user.click({ testId: `sidebar-session-${question.sessionId}` });
    await user.hover({ role: "tab", label: "Feed" });
    await user.press("Tab");
    const menu = await probe.eventually(() => probe.dom(`[data-testid="session-actions-${question.sessionId}"]`), {
      within: 5_000, label: "the More menu holds keyboard focus", until: (snapshot) => snapshot.elements[0]?.focused === true,
    });
    const shifts = moved(rest, await lanes(question.sessionId));
    const focused = menu.elements[0]?.focused === true;
    evidence.recordAssertionEvidence("focus keeps every lane", `More menu focused: ${focused}; moved: ${shifts.length ? shifts.join("; ") : "nothing"}`, focused && shifts.length === 0);
    expect(focused).toBe(true);
    expect(shifts).toEqual([]);
    await user.screenshot();
  });

  await step(`holding ${world.shortcutModifierLabel} shows each row's number in the shortcut lane without moving the title`, async () => {
    await user.click({ testId: `sidebar-session-${question.sessionId}` });
    await user.hover({ role: "tab", label: "Feed" });
    await world.holdShortcutModifier();
    try {
      const badges = await probe.eventually(() => probe.dom(`${row(question.sessionId)} [data-session-shortcut-badge]`), {
        within: 5_000, label: "the shortcut badge appears while the modifier is held", until: (snapshot) => snapshot.elements.length === 1,
      });
      const badge = badges.elements[0];
      const now = await lanes(question.sessionId);
      const shifts = moved(rest, now);
      const inLane = !!badge && badge.rect.left >= now.shortcut.left - 1 && badge.rect.right <= now.shortcut.right + 1;
      evidence.recordAssertionEvidence("held shortcut keeps every lane", `badge "${badge?.text ?? ""}" ${badge ? describe(badge.rect) : "missing"} inside lane ${describe(now.shortcut)}; moved: ${shifts.length ? shifts.join("; ") : "nothing"}`, inLane && shifts.length === 0);
      expect(inLane).toBe(true);
      expect(shifts).toEqual([]);
      await user.screenshot();
    } finally {
      await world.releaseShortcutModifier();
    }
    await user.notSee({ text: /^⌘\d$|^Ctrl\+\d$/ }, { timeoutMs: 3_000 });
  });

  await step("a task still waiting on a decision cannot be settled from its menu", async () => {
    await user.hover({ testId: `sidebar-session-${question.sessionId}` });
    await user.click({ testId: `session-actions-${question.sessionId}` });
    await user.see({ role: "menuitem", label: /Settle session/ });
    const disabled = (await probe.dom('[data-session-menu-settle][data-disabled]')).elements.length
      + (await probe.dom('[data-session-menu-settle][aria-disabled="true"]')).elements.length;
    evidence.recordAssertionEvidence("waiting task cannot settle", `disabled Settle items in the open menu: ${disabled}`, disabled >= 1);
    expect(disabled).toBeGreaterThanOrEqual(1);
    await user.screenshot();
    await user.press("Escape");
  });

  await step("the More menu settles the finished task onto the Settled shelf, and un-settles it back", async () => {
    await user.hover({ testId: `sidebar-session-${resting.sessionId}` });
    await user.click({ testId: `session-actions-${resting.sessionId}` });
    await user.click({ role: "menuitem", label: /^Settle session/ });
    const shelved = await probe.eventually(() => probe.dom(`[data-feed-shelf="settled"]`), {
      within: 10_000, label: "the Settled shelf appears", until: (snapshot) => snapshot.elements.length === 1,
    });
    const leftToday = (await probe.dom(`[data-sidebar-feed-section="today"] ${row(resting.sessionId)}`)).elements.length === 0;
    await user.click({ text: "Settled" });
    await user.see({ testId: `sidebar-session-${resting.sessionId}` });
    await user.screenshot();
    await user.hover({ testId: `sidebar-session-${resting.sessionId}` });
    await user.click({ testId: `session-actions-${resting.sessionId}` });
    await user.click({ role: "menuitem", label: /Un-settle session/ });
    const back = await probe.eventually(() => probe.dom(`[data-sidebar-feed-section="today"] ${row(resting.sessionId)}`), {
      within: 10_000, label: "the task returns under Today", until: (snapshot) => snapshot.elements.length === 1,
    });
    const ok = shelved.elements.length === 1 && leftToday && back.elements.length === 1;
    evidence.recordAssertionEvidence("Settle and Un-settle from the menu", `Settled shelf shown: ${shelved.elements.length === 1}; left Today: ${leftToday}; back under Today after Un-settle: ${back.elements.length === 1}`, ok);
    expect(ok).toBe(true);
  });

  await step("the same More menu pins and unpins the finished task, then renames it", async () => {
    const open = async () => {
      await user.hover({ testId: `sidebar-session-${resting.sessionId}` });
      await user.click({ testId: `session-actions-${resting.sessionId}` });
    };
    await open();
    await user.click({ role: "menuitem", label: "Pin session" });
    const pinned = await probe.eventually(() => probe.dom(`[data-global-pinned-sessions] ${row(resting.sessionId)}`), {
      within: 10_000, label: "the finished task moves onto Pinned", until: (snapshot) => snapshot.elements.length === 1,
    });
    await user.screenshot();
    await open();
    await user.click({ role: "menuitem", label: "Unpin session" });
    const returned = await probe.eventually(() => probe.dom(`[data-sidebar-feed-section="today"] ${row(resting.sessionId)}`), {
      within: 10_000, label: "the unpinned task returns under Today", until: (snapshot) => snapshot.elements.length === 1,
    });
    await open();
    await user.click({ role: "menuitem", label: "Rename session" });
    await user.type({ role: "textbox", label: "Session name" }, "Launch summary ready", { replace: true });
    await user.click({ role: "button", label: "Save" });
    const renamed = await probe.eventually(() => probe.dom(`${row(resting.sessionId)} [data-session-title-slot]`), {
      within: 10_000, label: "the new name reaches the Feed row", until: (snapshot) => snapshot.elements[0]?.text === "Launch summary ready",
    });
    evidence.recordAssertionEvidence("Pin, Unpin and Rename from More", `Pinned row: ${pinned.elements.length}; returned to Today: ${returned.elements.length}; title: ${renamed.elements[0]?.text}`,
      pinned.elements.length === 1 && returned.elements.length === 1 && renamed.elements[0]?.text === "Launch summary ready");
    await user.screenshot();
  });
});
