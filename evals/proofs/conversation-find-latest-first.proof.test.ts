import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { conversationFindLatestFirstWorld } from "../worlds/conversation-find-latest-first.ts";

const test = spec.world(conversationFindLatestFirstWorld, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb", "web"], services: ["den"] },
  needs: { commands: ["bun"] },
});

// This is DOM behavior, not a native-shell capability: app-web runs the real
// conversation renderer and native engine, without opening a desktop window.
test("a reader finds the newest conversation match first without enabling it for another member", async ({ world, user, probe, step, evidence }) => {
  const reader = user.on(world.app);
  const readerProbe = probe.on(world.app);
  const admin = user.on(world.admin);
  const adminProbe = probe.on(world.admin);
  const find = { placeholder: "Find in conversation" };
  // The app's command-palette entry owns its platform-specific shortcut.
  // Clicking the conversation's visible Find button works on all runner OSes.
  const openFind = async () => {
    await reader.click({ role: "button", label: "Find in conversation" });
    await reader.type(find, world.query);
  };
  const selection = async (expected: number) => readerProbe.eventually(async () => {
    const [marks, active, scroll] = await Promise.all([
      readerProbe.dom("[data-search-highlight]"), readerProbe.dom('[data-search-highlight-active="true"]'), readerProbe.dom("[data-thread-scroll]"),
    ]);
    const chosen = active.elements[0];
    const viewport = scroll.elements[0];
    const index = chosen ? marks.elements.findIndex(mark => mark.rect.top === chosen.rect.top && mark.rect.left === chosen.rect.left) : -1;
    const visible = Boolean(chosen && viewport && chosen.rect.top > viewport.rect.top && chosen.rect.bottom < viewport.rect.bottom);
    return { index, total: marks.elements.length, visible, firstTop: marks.elements[0]?.rect.top ?? 0, activeTop: chosen?.rect.top ?? 0 };
  }, { within: 15_000, label: `match ${expected + 1} of nine is selected and visible`, until: value => value.index === expected && value.total === 9 && value.visible });
  let earliestTop = 0;

  await reader.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("before: find selects the earliest of nine matches with the feature off", async () => {
    await reader.navigate(world.conversationUrl);
    await reader.see({ text: world.title }, { timeoutMs: 60_000 });
    await openFind();
    const found = await selection(0);
    earliestTop = found.firstTop;
    expect(await world.state()).toEqual({ reader: false, otherMember: false });
    expect(found.index).toBe(0);
    evidence.recordAssertionEvidence("Flag off starts at the first visible match", JSON.stringify(found), found.index === 0 && found.total === 9 && found.visible);
    await reader.looks([
      "Find in conversation contains orbital and shows the match counter 1/9.",
      "The EARLIEST checkpoint heading and an amber-highlighted orbital occurrence are visible in the conversation.",
    ]);
  });

  await step("before: Enter keeps the legacy forward direction", async () => {
    await reader.press("Enter");
    const found = await selection(1);
    expect(found.index).toBe(1);
    evidence.recordAssertionEvidence("Flag off Enter advances from 1/9 to 2/9", JSON.stringify(found), found.index === 1 && found.visible);
    await reader.looks([
      "Find in conversation contains orbital and shows the match counter 2/9.",
      "The MIDDLE 2 checkpoint heading and an amber-highlighted orbital occurrence are visible in the conversation.",
    ]);
  });

  await step("the owner enables latest-first for this reader through member features", async () => {
    await admin.see({ role: "heading", label: "Checkpoint review team" }, { timeoutMs: 60_000 });
    await admin.click({ testId: `admin-member-features-${world.memberId}` });
    await admin.see({ testId: "admin-member-feature-editor" });
    // Trusted wheel input reveals the existing real admin control; no script
    // changes the flag or the page's scroll position.
    let visible = false;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const row = (await adminProbe.dom('[data-testid="admin-capability-conversationFindLatestFirst"]')).elements[0];
      if (row && row.rect.top > 90 && row.rect.bottom < 820) { visible = true; break; }
      await admin.wheelAt({ x: 1100, y: 700, deltaY: row && row.rect.top < 90 ? -550 : 550 });
    }
    expect(visible).toBe(true);
    await admin.click({ testId: "admin-capability-conversationFindLatestFirst" });
    await admin.see({ testId: "admin-capability-source-conversationFindLatestFirst" }, { text: "Set for this member" });
    const state = await adminProbe.eventually(world.state, { within: 10_000, label: "the reader alone receives the real Den override", until: value => value.reader === true });
    expect(state).toEqual({ reader: true, otherMember: false });
    evidence.recordAssertionEvidence("Only the selected member receives latest-first", JSON.stringify(state), state.reader === true && state.otherMember === false);
    await admin.looks([
      "The member feature editor shows Conversation find: latest first with its switch on.",
      "The Conversation find: latest first feature shows Set for this member.",
    ]);
  });

  await step("after: find selects the latest match and scrolls it into view", async () => {
    await reader.reload();
    await reader.see({ text: world.title }, { timeoutMs: 60_000 });
    await openFind();
    const found = await selection(8);
    const scrollDistance = earliestTop - found.firstTop;
    expect(found.index).toBe(8);
    expect(scrollDistance).toBeGreaterThan(1_000);
    evidence.recordAssertionEvidence("Flag on starts at 9/9 and moves through the actual long history", JSON.stringify({ ...found, scrollDistance }), found.index === 8 && found.visible && scrollDistance > 1_000);
    await reader.looks([
      "Find in conversation contains orbital and shows the match counter 9/9.",
      "The LATEST checkpoint heading and an amber-highlighted orbital occurrence are visible in the conversation.",
    ]);
  });

  await step("Enter searches older matches and Shift+Enter returns to newer matches", async () => {
    await reader.press("Enter");
    const older = await selection(7);
    await reader.looks([
      "Find in conversation contains orbital and shows the match counter 8/9.",
      "The MIDDLE 8 checkpoint heading and an amber-highlighted orbital occurrence are visible in the conversation.",
    ]);
    await reader.press("Shift+Enter");
    const newer = await selection(8);
    expect([older.index, newer.index]).toEqual([7, 8]);
    evidence.recordAssertionEvidence("Enter reaches 8/9; Shift+Enter returns to 9/9", JSON.stringify({ older, newer }), older.index === 7 && newer.index === 8 && older.visible && newer.visible);
    await reader.looks([
      "Find in conversation contains orbital and shows the match counter 9/9.",
      "The LATEST checkpoint heading and an amber-highlighted orbital occurrence are visible in the conversation.",
    ]);
  });

  await step("search wraps in both directions without losing the selected result", async () => {
    await reader.press("Shift+Enter");
    const oldest = await selection(0);
    await reader.looks([
      "Find in conversation contains orbital and shows the match counter 1/9.",
      "The EARLIEST checkpoint heading and an amber-highlighted orbital occurrence are visible in the conversation.",
    ]);
    await reader.press("Enter");
    const newest = await selection(8);
    expect([oldest.index, newest.index]).toEqual([0, 8]);
    evidence.recordAssertionEvidence("Newer wraps 9/9 to 1/9; older wraps 1/9 to 9/9", JSON.stringify({ oldest, newest }), oldest.index === 0 && newest.index === 8 && oldest.visible && newest.visible);
    await reader.looks([
      "Find in conversation contains orbital and shows the match counter 9/9.",
      "The LATEST checkpoint heading and an amber-highlighted orbital occurrence are visible in the conversation.",
    ]);
  });

  await step("the arrow buttons keep their spatial direction and the other member stays off", async () => {
    await reader.click({ role: "button", label: "Previous match" });
    const older = await selection(7);
    await reader.click({ role: "button", label: "Next match" });
    const newer = await selection(8);
    const state = await world.state();
    expect([older.index, newer.index]).toEqual([7, 8]);
    expect(state).toEqual({ reader: true, otherMember: false });
    evidence.recordAssertionEvidence("Up is older, Down is newer; the other member still inherits off", JSON.stringify({ older, newer, state }), older.index === 7 && newer.index === 8 && state.otherMember === false);
    await reader.looks([
      "Find in conversation contains orbital and shows the match counter 9/9.",
      "The LATEST checkpoint heading and an amber-highlighted orbital occurrence are visible in the conversation.",
    ]);
  });
});
