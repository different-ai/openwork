import { spec } from "@openwork/testkit";
import { expect } from "vitest";
import { BROWSER_HANDOFF, BROWSER_INSPECT, BROWSER_OTHER, BROWSER_REOPEN, BROWSER_REVIEW, BROWSER_START, coworkerBrowserWorld } from "../worlds/coworker-browser.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const browserTest = spec.world(coworkerBrowserWorld, {
  needs: { placement: "local", optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
  timeout: 360_000,
});

browserTest("A native Coworker browser turn keeps pages owned while discussions and panels change", { timeout: 300_000 }, async ({ world, user, step }) => {
  const waitReceipt = async (id: string) => {
    await expect.poll(() => {
      expect(world.model.errors).toEqual([]);
      return world.model.receipts.some((item) => item.id === id);
    }, { timeout: 45_000 }).toBe(true);
    return world.receipt(id);
  };
  const send = async (prompt: string, reply: string, finalReceipt?: string) => {
    await user.type({ role: "textbox", label: "Message Editor" }, prompt);
    await user.click({ label: "Send" });
    if (prompt === BROWSER_INSPECT) {
      await expect.poll(() => { expect(world.model.errors).toEqual([]); return world.model.waiting.has("page-ready"); }, { timeout: 45_000 }).toBe(true);
      await expect.poll(() => world.ui(), { timeout: 15_000 }).toMatchObject({ browserOpen: false, browserPreview: true, thumbnail: { loaded: true } });
      await user.click({ testId: "coworker-browser-preview" });
      await user.see({ testId: "coworker-browser-panel" });
      await expect.poll(() => world.ui(), { timeout: 10_000 }).toMatchObject({ mode: "side", control: "watch", watchImage: { loaded: true } });
      expect(await world.page()).toMatchObject({ count: 0, draft: "Initial draft" });
      world.model.release("page-ready");
    }
    if (finalReceipt) await waitReceipt(finalReceipt);
    await user.see({ text: reply }, { timeoutMs: 90_000 });
    await expect.poll(() => world.ui(), { timeout: 30_000 }).toMatchObject({ idle: true });
  };
  let firstDiscussion: unknown;

  await step("The real engine opens, snapshots, evaluates and screenshots its owned HTTP page", async () => {
    for (const prompt of [BROWSER_START, BROWSER_INSPECT, BROWSER_REVIEW, BROWSER_OTHER, BROWSER_REOPEN, BROWSER_HANDOFF]) {
      expect(prompt).not.toMatch(/coworker_browser_|snapshot_id|target_id|ses_/);
    }
    await send(BROWSER_START, "The browser discussion is ready.");
    await user.click({ testId: "coworker-discussion-switcher" });
    firstDiscussion = (await world.ui()).activeDiscussion;
    expect(firstDiscussion).toEqual(expect.stringMatching(/^ses_/));
    await user.press("Escape");
    await send(BROWSER_INSPECT, "The browser inspection is complete.", "tabs");
    expect(world.result("open")).toMatchObject({ url: `${world.origin}/review`, tab_id: expect.any(String), target_id: expect.any(String) });
    expect(world.result("snapshot")).toMatchObject({ snapshot_id: expect.any(String), snapshot: expect.any(String) });
    expect(world.result("eval")).toMatchObject({ title: "Browser review", url: `${world.origin}/review`, count: 0, draft: "Initial draft" });
    expect(await world.page()).toMatchObject({ count: 0, draft: "Initial draft" });
    const png = await world.screenshotSize();
    expect(png.width).toBeGreaterThan(100);
    expect(png.height).toBeGreaterThan(100);
    expect(world.result("tabs")).toEqual([world.result("open")]);
    expect(world.model.catalogs.some((tools) => tools.some((name) => name.startsWith("browser_")))).toBe(false);
    expect(world.requests).toContain("/review");
    await user.see({ testId: "coworker-browser-panel" });
    await user.see({ label: "Browser address" }, { value: `${world.origin}/review` });
  });

  await step("Another saved discussion cannot observe, edit or close the first page, and background open never steals it", async () => {
    await user.click({ testId: "coworker-discussion-switcher" });
    await user.click({ testId: "coworker-new-discussion" });
    await user.see({ testId: "coworker-discussion-empty" });
    await expect.poll(() => world.ui(), { timeout: 15_000 }).toMatchObject({ discussion: expect.stringContaining("New discussion"), browserOpen: false });
    await user.type({ label: "Message Editor" }, BROWSER_OTHER);
    await user.click({ label: "Send" });
    await expect.poll(() => { expect(world.model.errors).toEqual([]); return world.model.waiting.has("background"); }, { timeout: 60_000 }).toBe(true);
    expect(world.result("other-tabs-before")).toEqual([]);
    for (const id of ["cross-snapshot", "cross-eval", "cross-close"]) expect(world.receipt(id).output).toMatch(/not owned by the native discussion/);
    expect(await world.page()).toMatchObject({ count: 0, draft: "Initial draft" });
    await user.click({ testId: "coworker-discussion-switcher" });
    const secondDiscussion = (await world.ui()).activeDiscussion;
    expect(secondDiscussion).toEqual(expect.stringMatching(/^ses_/));
    expect(secondDiscussion).not.toBe(firstDiscussion);
    await user.click({ text: BROWSER_START });
    await user.see({ testId: "coworker-browser-panel" });
    const before = await world.ui();
    world.model.release("background");
    await waitReceipt("other-tabs-after");
    expect(world.result("other-eval")).toMatchObject({ title: "Other review", url: `${world.origin}/other`, count: 0, draft: "Initial draft" });
    expect(world.result("other-tabs-after")).toEqual([world.result("other-open")]);
    expect(world.handle("other-open").target_id).not.toBe(world.handle().target_id);
    expect(await world.ui()).toMatchObject({ discussion: before.discussion, browserOpen: true, tabs: before.tabs, bounds: before.bounds });
    expect(await world.page()).toMatchObject({ count: 0, draft: "Initial draft" });
    expect(world.requests).toContain("/other");
  });

  await step("Closing the last tab and reopening at unchanged bounds restores the page inside the discussion", async () => {
    const before = await world.ui();
    await world.clickWatchIncrement();
    await expect.poll(() => world.ui(), { timeout: 10_000 }).toMatchObject({ control: "ready", handoff: true, watchImage: null });
    expect(await world.page()).toMatchObject({ count: 0, draft: "Initial draft" });
    await user.click({ label: "Close Browser review" });
    await expect.poll(() => world.ui(), { timeout: 10_000 }).toMatchObject({ browserOpen: true, tabs: [] });
    await user.type({ label: "Browser address" }, `${world.origin}/reopened`, { replace: true });
    await user.click({ label: "Go" });
    await user.see({ role: "tab", text: "Browser review" });
    await expect.poll(() => world.ui(), { timeout: 10_000 }).toMatchObject({ bounds: before.bounds, control: "ready" });
    await user.click({ testId: "coworker-browser-resume" });
    await expect.poll(() => world.ui(), { timeout: 10_000 }).toMatchObject({ handoff: false, control: "watch", watchImage: { loaded: true } });
    await send(BROWSER_REOPEN, "The reopened browser page is ready.", "reopened-eval");
    expect(world.result("reopened-eval")).toMatchObject({ title: "Browser review", url: `${world.origin}/reopened`, count: 0, draft: "Initial draft" });
    expect(world.handle("reopened-tabs").target_id).not.toBe(world.handle().target_id);
  });

  await step("Sign-in holds the original native call until the person resumes, without replaying stale actions", async () => {
    await user.type({ label: "Message Editor" }, BROWSER_HANDOFF);
    await user.click({ label: "Send" });
    await user.see({ testId: "coworker-browser-handoff" }, { text: /Waiting for sign-in.*Browser tools are paused/s, timeoutMs: 45_000 });
    await expect.poll(() => world.ui(), { timeout: 10_000 }).toMatchObject({ idle: false, control: "ready", watchImage: null });
    await expect.poll(async () => {
      const current = await world.ui();
      const page = await world.page("reopened-tabs");
      if (!isRecord(current.bounds) || !isRecord(page)) throw new Error("No human viewport bounds");
      // Only human-ready mode attaches the native view; watch mode uses an image.
      return Math.max(Math.abs(Number(page.width) - Number(current.bounds.width)), Math.abs(Number(page.height) - Number(current.bounds.height)));
    }, { timeout: 5_000 }).toBeLessThanOrEqual(1);
    await user.click({ testId: "coworker-browser-collapse" });
    await expect.poll(() => world.ui(), { timeout: 10_000 }).toMatchObject({ browserOpen: false, browserPreview: true, thumbnail: null, handoff: true });
    await user.click({ role: "button", label: /^OpenWork\b/ });
    await user.see({ testId: "openwork-settings" });
    await user.notSee({ testId: "coworker-browser-preview" });
    await user.click({ label: "Close settings" });
    await user.click({ testId: "coworker-browser-preview" });
    await user.click({ testId: "coworker-browser-fullscreen" });
    await expect.poll(() => world.ui(), { timeout: 10_000 }).toMatchObject({ modal: true, mode: "fullscreen", control: "ready", handoff: true, idle: false });
    // Escape originates in the owned native browser page, not OS computer control.
    await user.on(await world.pageSurface("reopened-tabs")).click({ label: "Draft text" });
    await user.on(await world.pageSurface("reopened-tabs")).press("Escape");
    await expect.poll(() => world.ui(), { timeout: 10_000 }).toMatchObject({ modal: false, mode: "side", control: "ready", handoff: true, idle: false });
    expect(world.model.receipts.some((item) => item.id === "handoff")).toBe(false);
    expect(world.model.calls.some((item) => item.id === "handoff-stale-eval")).toBe(false);
    expect(world.model.catalogs.flat().some((name) => /^coworker_browser_.*(?:resume|continue)/.test(name))).toBe(false);
    expect(await world.page("reopened-tabs")).toMatchObject({ count: 0, draft: "Initial draft" });
    await user.click({ testId: "coworker-browser-resume" });
    await waitReceipt("handoff-eval");
    await user.see({ text: "The browser sign-in checkpoint is complete." }, { timeoutMs: 30_000 });
    expect(world.result("handoff")).toEqual({ state: "continued", next: "snapshot", fresh_observation_required: true, actions_replayed: false });
    expect(world.model.calls.filter((item) => item.name === "coworker_browser_handoff")).toHaveLength(1);
    for (const id of ["handoff-stale-eval", "handoff-stale-navigate"]) expect(world.receipt(id).output).toMatch(/Take a fresh snapshot before acting; no input was dispatched/);
    for (const id of ["handoff-stale-click", "handoff-stale-fill"]) expect(world.receipt(id).output).toMatch(/snapshot_id is stale/);
    expect(world.requests).not.toContain("/must-not-navigate");
    expect(world.result("handoff-fresh")).toMatchObject({ snapshot_id: expect.any(String), snapshot: expect.stringContaining("Draft text") });
    expect(world.result("handoff-eval")).toMatchObject({ url: `${world.origin}/reopened`, count: 0, draft: "Initial draft" });
    expect(await world.page("reopened-tabs")).toMatchObject({ count: 0, draft: "Initial draft" });
    await expect.poll(() => world.ui(), { timeout: 30_000 }).toMatchObject({ idle: true, handoff: false, control: "watch" });
  });

  await step("Discussion menus and the document/settings aside remain usable over the browser", async () => {
    await world.narrowDesktopViewport();
    await user.click({ testId: "coworker-discussion-switcher" });
    await user.see({ testId: "coworker-discussion-menu" });
    expect((await world.ui()).activeDiscussion).toBe(firstDiscussion);
    await user.press("Escape");
    await user.click({ testId: "context-rail-overview" });
    await expect.poll(() => world.ui(), { timeout: 10_000 }).toMatchObject({ aside: { width: 320, collapsed: "false" } });
    await user.click({ testId: "activity-row-documents" });
    await user.see({ testId: "documents-panel" }, { text: /No documents yet/ });
    expect((await world.ui()).aside).toMatchObject({ tag: "ASIDE", overlay: "true", view: "overview", collapsed: "false" });
    await user.press("Escape");
    await expect.poll(() => world.ui(), { timeout: 10_000 }).toMatchObject({ aside: { depth: "0" } });
    await user.press("Escape");
    await expect.poll(() => world.ui(), { timeout: 10_000 }).toMatchObject({ aside: { width: 56, collapsed: "true" } });
    await user.click({ testId: "context-rail-settings" });
    await user.see({ testId: "context-panel" }, { text: /Coworker settings/ });
    expect((await world.ui()).aside).toMatchObject({ tag: "ASIDE", overlay: "true", view: "settings", collapsed: "false" });
    expect((await world.ui()).browserOpen).toBe(true);
    expect(world.model.errors).toEqual([]);
  });

  await step("Take over denies model reads and edits; resume requires fresh single-use snapshots for input", async () => {
    await user.press("Escape");
    await expect.poll(() => world.ui(), { timeout: 10_000 }).toMatchObject({ aside: { width: 56, collapsed: "true" } });
    await user.type({ label: "Message Editor" }, BROWSER_REVIEW);
    await user.click({ label: "Send" });
    await expect.poll(() => { expect(world.model.errors).toEqual([]); return world.model.waiting.has("takeover"); }, { timeout: 45_000 }).toBe(true);
    await user.click({ testId: "coworker-browser-takeover" });
    await expect.poll(() => world.ui(), { timeout: 10_000 }).toMatchObject({ control: "ready", handoff: true, watchImage: null });
    world.model.release("takeover");
    await expect.poll(() => { expect(world.model.errors).toEqual([]); return world.model.waiting.has("takeover-resume"); }, { timeout: 45_000 }).toBe(true);
    for (const id of ["takeover-read", "takeover-edit"]) expect(world.receipt(id).output).toMatch(/The person has browser control\. Only they can Resume in the app/);
    expect(await world.page("reopened-tabs")).toMatchObject({ count: 0, draft: "Initial draft" });
    await user.click({ testId: "coworker-browser-resume" });
    await expect.poll(() => world.ui(), { timeout: 5_000 }).toMatchObject({ handoff: false, control: "watch" });
    world.model.release("takeover-resume");
    await expect.poll(() => { expect(world.model.errors).toEqual([]); return world.model.waiting.has("controls-input"); }, { timeout: 45_000 }).toBe(true);
    // Fail on the actual provider snapshot, not a guessed UID or a replacement AX parser.
    expect(world.result("snapshot-click")).toMatchObject({ snapshot_id: expect.any(String), snapshot: expect.stringContaining('button "Increment"') });
    world.model.release("controls-input");
    await waitReceipt("review-screenshot");
    await user.see({ text: "The browser review is complete." }, { timeoutMs: 30_000 });
    expect(world.result("snapshot-fill")).toMatchObject({ snapshot_id: expect.any(String), snapshot: expect.stringContaining("Draft text") });
    expect(world.result("snapshot-fill")).not.toEqual(world.result("snapshot-click"));
    expect(world.receipt("stale-click").output).toMatch(/snapshot_id is stale/);
    expect(world.result("review-eval")).toMatchObject({ count: 1, draft: "Reviewed in Coworker" });
    expect(await world.page("reopened-tabs")).toMatchObject({ count: 1, draft: "Reviewed in Coworker" });
    expect((await world.screenshotSize("review-screenshot")).width).toBeGreaterThan(100);
    expect(world.model.errors).toEqual([]);
  });
});
