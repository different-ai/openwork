import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { feedHiddenSideChats } from "../worlds/feed-hidden-side-chats.ts";

const test = spec.world(feedHiddenSideChats, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { commands: ["bun"] },
});

const today = '[data-sidebar-feed-section="today"]';
const row = (id: string) => `${today} [data-sidebar-session-id="${id}"]`;
const secondary = '[data-workbench-pane="secondary"]';
const sideHeader = '[data-workbench-pane-header="secondary"]';

// Three real idle sessions, no model calls. The waiting-on-a-question exception
// needs a separate scripted-model journey; it is not simulated by setting status.
test("a member's Feed closes the space left by an attached idle side chat, including after reload", async ({ world, user, probe, step, evidence }) => {
  const { above, side, below } = world;
  const target = (id: string) => ({ testId: `sidebar-session-${id}` });
  const top = async (id: string) => {
    const { elements } = await probe.dom(row(id));
    expect(elements, `one visible Feed row for ${id}`).toHaveLength(1);
    const element = elements[0];
    if (!element) throw new Error(`Missing Feed row ${id}`);
    return element.rect.top;
  };
  const hidden = () => probe.eventually(() => probe.dom(row(side.sessionId)), {
    within: 15_000, label: "the attached idle discussion leaves the Feed",
    until: value => value.elements.length === 0,
  });
  const restoredPane = () => probe.eventually(() => probe.dom(sideHeader), {
    within: 30_000, label: "the saved side discussion opens beside its owner",
    until: value => value.elements.length === 1 && value.elements[0]?.text.includes(side.title) === true,
  });
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });

  await step("before: three idle conversations are consecutive Feed rows, 50 pixels apart", async () => {
    await user.see("composer", { editable: true, timeoutMs: 60_000 });
    await user.click({ role: "tab", label: "Feed" });
    for (const session of [above, side, below]) await user.see(target(session.sessionId), { timeoutMs: 60_000 });
    expect(await probe.hash()).toContain(above.sessionId);
    const [upper, middle, lower] = await Promise.all([top(above.sessionId), top(side.sessionId), top(below.sessionId)]);
    const tops = [upper, middle, lower];
    const gaps = [Math.round(middle - upper), Math.round(lower - middle)];
    evidence.recordAssertionEvidence("The discussion starts between two ordinary rows", `top to bottom: ${above.title}, ${side.title}, ${below.title}; tops=${tops.join(",")}; steps=${gaps.join(",")}px; expected=50,50px`, gaps.every(gap => gap === 50));
    await user.screenshot();
    expect(gaps).toEqual([50, 50]);
  });

  await step("the member opens the middle conversation as a side chat, then selects another task", async () => {
    await user.hover(target(side.sessionId));
    await user.click({ testId: `session-actions-${side.sessionId}` });
    await user.click({ role: "menuitem", label: "Open as side chat" });
    await restoredPane();
    expect(await probe.hash()).toContain(above.sessionId);
    await hidden();
    await user.click(target(below.sessionId));
    await probe.eventually(() => probe.dom(secondary), {
      within: 15_000, label: "the unrelated task has no side pane",
      until: value => value.elements.length === 0,
    });
    const absent = await hidden();
    const route = await probe.hash();
    evidence.recordAssertionEvidence("An idle attachment stays hidden when its owner is not selected", `selected=${below.title}; side panes=0; hidden discussion rows=${absent.elements.length}; both neighboring tasks remain visible`, route.includes(below.sessionId) && absent.elements.length === 0);
    await user.see(target(above.sessionId));
    await user.see(target(below.sessionId));
    await user.screenshot();
    expect(route).toContain(below.sessionId);
  });

  await step("after: the attachment survives reload and its visible Feed neighbors are still only 50 pixels apart", async () => {
    await user.reload();
    await user.see({ role: "tab", label: "Feed" }, { timeoutMs: 60_000 });
    await user.see(target(above.sessionId), { timeoutMs: 60_000 });
    await user.see(target(below.sessionId), { timeoutMs: 60_000 });
    expect((await probe.dom('[data-sidebar-view="feed"][aria-selected="true"]')).elements).toHaveLength(1);
    // Returning to the owner witnesses that the attachment really persisted;
    // mere absence of the discussion row could otherwise be a lost session.
    await user.click(target(above.sessionId));
    await restoredPane();
    await hidden();
    await user.hover({ role: "tab", label: "Feed" });
    const upperTop = await top(above.sessionId);
    const lowerTop = await top(below.sessionId);
    const gap = Math.round(lowerTop - upperTop);
    evidence.recordAssertionEvidence("A hidden side chat reserves no empty Feed row after reload", `saved side pane=${side.title}; selected=${above.title}; hidden discussion rows=0; upper top=${upperTop}px; lower top=${lowerTop}px; neighboring step=${gap}px; expected=50px`, gap === 50);
    // Keep the base bug's screenshot even when its empty 50px virtual slot fails
    // the assertion below (100px observed instead of the normal 50px step).
    await user.screenshot();
    expect(gap, "visible Feed neighbors must not retain the hidden discussion's virtual slot").toBe(50);
  });
});
