import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sessionMultiSelectWorld } from "../worlds/session-multi-select.ts";

const test = spec.world(sessionMultiSelectWorld, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["den", "mock"] },
});

const selectedRows = '[data-session-multi-selected="true"]';
const bar = "[data-session-selection-bar]";
const multiSelectOn = '[data-session-multi-select="on"]';

test("a member selects three sessions with Ctrl-click and Shift-click and archives them in one step, with one undo", async ({ world, user, probe, step, evidence }) => {
  const [draft, compare, summarize, offsite] = world.sessions;
  if (!draft || !compare || !summarize || !offsite) throw new Error("The world seeds four sessions");
  const row = (id: string) => ({ testId: `sidebar-session-${id}` });
  const selectedIds = async () => (await probe.dom(selectedRows)).elements.length;
  const barText = async () => (await probe.dom(bar)).elements.map(element => element.text.replace(/\s+/g, " ").trim()).join(" ");
  const toasts = async () => (await probe.dom("[data-sonner-toast]")).elements.map(element => element.text.replace(/\s+/g, " ").trim());
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });

  await step("before: Ctrl-clicking a session in the sidebar just opens it", async () => {
    await user.see("composer", { timeoutMs: 60_000 });
    for (const session of world.sessions) await user.see(row(session.sessionId), { timeoutMs: 60_000 });
    await user.click(row(compare.sessionId), { modifiers: ["Control"] });
    const route = await probe.eventually(() => probe.hash(), {
      within: 15_000, label: "the Ctrl-clicked session opens", until: hash => hash.includes(compare.sessionId),
    });
    const selected = await selectedIds();
    const bars = (await probe.dom(bar)).elements.length;
    const enabled = (await probe.dom(multiSelectOn)).elements.length;
    evidence.recordAssertionEvidence(
      "Without multi-select, a modified click opens one session and selects nothing",
      `opened=${compare.title}; selected rows=${selected}; selection bars=${bars}; multi-select lists=${enabled}`,
      route.includes(compare.sessionId) && selected === 0 && bars === 0 && enabled === 0,
    );
    await user.screenshot();
    expect(selected).toBe(0);
    expect(bars).toBe(0);
  });

  await step("after: Shift-click selects a range of three from the open session, and Ctrl-click toggles a fourth in and out", async () => {
    await world.turnOnMultiSelect();
    await user.reload();
    await user.see(row(offsite.sessionId), { timeoutMs: 60_000 });
    await probe.eventually(() => probe.dom(multiSelectOn), {
      within: 60_000, label: "the organization's multi-select setting reaches the sidebar", until: value => value.elements.length === 1,
    });
    await user.click(row(summarize.sessionId));
    await probe.eventually(() => probe.hash(), {
      within: 15_000, label: "the starting session opens", until: hash => hash.includes(summarize.sessionId),
    });
    await user.click(row(draft.sessionId), { modifiers: ["Shift"] });
    await probe.eventually(() => selectedIds(), { within: 10_000, label: "the range holds three rows", until: value => value === 3 });
    await user.click(row(offsite.sessionId), { modifiers: ["Control"] });
    await probe.eventually(() => selectedIds(), { within: 10_000, label: "Ctrl-click adds a fourth row", until: value => value === 4 });
    await user.click(row(offsite.sessionId), { modifiers: ["Control"] });
    const count = await probe.eventually(() => selectedIds(), { within: 10_000, label: "Ctrl-click takes it out again", until: value => value === 3 });
    const text = await barText();
    const offsiteSelected = (await probe.dom(`${selectedRows}[data-session-tab-id="${offsite.sessionId}"]`)).elements.length;
    evidence.recordAssertionEvidence(
      "Shift-click then Ctrl-click leave exactly the three sessions to clean up selected",
      `selected rows=${count}; untouched row selected=${offsiteSelected}; bar="${text}"`,
      count === 3 && offsiteSelected === 0 && text.includes("3 selected") && text.includes("Archive 3 sessions"),
    );
    await user.screenshot();
    expect(text).toContain("3 selected");
    expect(text).toContain("Archive 3 sessions");
    expect(offsiteSelected).toBe(0);
  });

  await step("after: one Archive click archives all three and one Undo brings them back", async () => {
    await user.click({ role: "button", label: "Archive 3 sessions" });
    const shown = await probe.eventually(() => toasts(), {
      within: 30_000, label: "one toast reports the three archived sessions", until: list => list.some(entry => entry.includes("3 sessions archived")),
    });
    for (const session of [draft, compare, summarize]) await user.notSee(row(session.sessionId), { timeoutMs: 15_000 });
    await user.see(row(offsite.sessionId));
    const bars = (await probe.dom(bar)).elements.length;
    evidence.recordAssertionEvidence(
      "Archiving the selection moves all three sessions out of the list and clears the selection",
      `toasts=${JSON.stringify(shown)}; still listed=${offsite.title}; selection bars=${bars}`,
      shown.some(entry => entry.includes("3 sessions archived")) && bars === 0,
    );
    await user.screenshot();
    await user.click({ role: "button", label: "Undo" });
    for (const session of [draft, compare, summarize]) await user.see(row(session.sessionId), { timeoutMs: 30_000 });
    const listed = await Promise.all([draft, compare, summarize, offsite].map(async session =>
      (await probe.dom(`[data-sidebar-session-id="${session.sessionId}"]:not([data-global-archived-sessions] *)`)).elements.length));
    evidence.recordAssertionEvidence(
      "One Undo restores every archived session",
      `rows back in the list per session (${[draft, compare, summarize, offsite].map(session => session.title).join(", ")})=${listed.join(",")}`,
      listed.every(count => count === 1),
    );
    await user.screenshot();
    expect(bars).toBe(0);
    expect(listed).toEqual([1, 1, 1, 1]);
  });
});
