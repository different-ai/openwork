import { expect } from "vitest";
import { spec, type Probe, type User } from "@openwork/testkit";
import { cmdkSessionActionParity } from "../worlds/cmdk-session-action-parity.ts";

const test = spec.world(cmdkSessionActionParity, {
  timeout: 300_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { commands: ["bun"] },
});

const paletteInput = "[data-command-palette-input]";
const paletteRows = "[data-command-palette-item]";
const paletteTarget = { role: "combobox" } satisfies Parameters<User["type"]>[0];
const secondary = '[data-workbench-pane="secondary"]';
type World = Awaited<ReturnType<typeof cmdkSessionActionParity>>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyboard(user: User, probe: Probe) {
  let chord = "Meta+k";
  let resolved = false;
  const search = async (text: string) => {
    await user.press(chord);
    if (!resolved) {
      const opened = await probe.eventually(() => probe.dom(paletteInput), {
        within: 1_500, label: "Command opens search on macOS",
        until: value => value.elements.some(element => element.focused),
      }).then(() => true, () => false);
      if (!opened) {
        chord = "Control+k";
        await user.press(chord);
      }
      resolved = true;
    }
    await user.see(paletteTarget, { editable: true });
    await probe.eventually(() => probe.dom(paletteInput), {
      within: 5_000, label: "search receives keyboard focus",
      until: value => value.elements.some(element => element.focused),
    });
    await user.type(paletteTarget, text, { replace: true });
  };
  const closed = async () => {
    await probe.eventually(() => probe.dom(paletteInput), {
      within: 5_000, label: "search closes before the next action",
      until: value => value.elements.length === 0,
    });
  };
  return { search, closed };
}

async function nativeSession(probe: Probe, world: World, sessionId: string) {
  const response = await probe.desktopApi(`/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode2/api/session/${encodeURIComponent(sessionId)}`);
  expect(response.status).toBe(200);
  const value = record(response.body) && "data" in response.body ? response.body.data : response.body;
  if (!record(value) || !record(value.time)) throw new Error("The native session response has no identity or times");
  expect(value.id).toBe(sessionId);
  return {
    id: value.id,
    title: value.title,
    time: value.time,
    archived: typeof value.time.archived === "number" && value.time.archived > 0,
  };
}

async function expectPins(probe: Probe, world: World, pinned: boolean) {
  // Observe the product's Pinned section, not its store. The final reload must
  // rehydrate this same row, proving persistence without a storage backdoor.
  const saved = await probe.eventually(async () => {
    const [all, main, side, reference] = await Promise.all([
      probe.dom('[data-global-pinned-sessions] [data-testid^="sidebar-session-"]'),
      ...[world.main, world.side, world.untouched].map(session => probe.dom(`[data-global-pinned-sessions] [data-testid="sidebar-session-${session.sessionId}"]`)),
    ]);
    return { rows: all.elements.length, main: main?.elements.length, side: side?.elements.length, reference: reference?.elements.length };
  }, {
    within: 10_000, label: "only the intended conversation appears in Pinned",
    until: value => value.rows === (pinned ? 1 : 0) && value.main === (pinned ? 1 : 0) && value.side === 0 && value.reference === 0,
  });
  expect(saved).toEqual({ rows: pinned ? 1 : 0, main: pinned ? 1 : 0, side: 0, reference: 0 });
  return saved;
}

// Pinned rows can move between sidebar sections. Prove the workspace/identity
// scope and uniqueness before using the public test id; never select the first
// of several copies or guess a DOM index.
async function mainRow(user: User, probe: Probe, world: World) {
  const target = { role: "button", testId: `sidebar-session-${world.main.sessionId}` } satisfies Parameters<User["hover"]>[0];
  const selector = `[data-testid="${target.testId}"]`;
  await user.see(target);
  expect((await probe.dom(`[data-sidebar-session-workspace-id="${world.workspace.workspaceId}"] ${selector}`)).elements).toHaveLength(1);
  expect((await probe.dom(selector)).elements).toHaveLength(1);
  await user.hover(target);
  return target;
}

// No capability is enabled for this proof: the existing world's legacy quick
// Pin/Archive controls and row context menu are the baseline under refactor.
// Delete consent and waiting-for-answer archive guards remain in the separate
// cmdk-session-action-parity proof; this story sends no model turn.
test("a member keeps the same main conversation through quick actions, its menu and Cmd+K while a side chat has focus", async ({ world, user, probe, step, evidence }) => {
  const keys = keyboard(user, probe);
  const mainUrl = new URL(`/workspace/${encodeURIComponent(world.workspace.workspaceId)}/session/${encodeURIComponent(world.main.sessionId)}`, world.app.webUrl).href;
  const witnesses = [world.side, world.untouched];
  const beforeOthers = await Promise.all(witnesses.map(session => nativeSession(probe, world, session.sessionId)));
  const beforeMain = await nativeSession(probe, world, world.main.sessionId);
  const unchangedOthers = async () => {
    const current = await Promise.all(witnesses.map(session => nativeSession(probe, world, session.sessionId)));
    expect(current).toEqual(beforeOthers);
    return current;
  };
  const focusSide = async () => {
    await user.see({ role: "textbox", nth: 1 }, { editable: true });
    await user.click({ role: "textbox", nth: 1 });
    expect((await probe.dom(`${secondary}[data-workbench-pane-focused="true"][data-workbench-workspace-id="${world.workspace.workspaceId}"]`)).elements).toHaveLength(1);
    expect((await probe.dom('[data-workbench-pane-header="secondary"]')).elements[0]?.text).toContain(world.side.title);
    expect(await probe.hash()).toContain(world.main.sessionId);
  };
  const mainAction = async (label: string) => {
    await keys.search(label);
    await user.see({ role: "option", label: new RegExp(`^${label}`) });
    const row = (await probe.dom(paletteRows)).elements.find(element => element.text.startsWith(label));
    expect(row?.text).toContain(world.main.title);
    expect(row?.text).not.toContain(world.side.title);
    return row?.text;
  };
  const archiveState = async (archived: boolean) => {
    const current = await probe.eventually(() => nativeSession(probe, world, world.main.sessionId), {
      within: 15_000, label: archived ? "the named native conversation is archived" : "the same native conversation is restored",
      until: value => value.archived === archived,
    });
    expect(current.id).toBe(world.main.sessionId);
    expect(current.title).toBe(world.main.title);
    await unchangedOthers();
    // Archived conversations leave Pinned; restoring them must bring the same
    // pin back without another Pin action.
    await expectPins(probe, world, !archived);
    return current;
  };
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });

  await step("given a saved main conversation and a different saved side chat with focus", async () => {
    await user.see("composer", { editable: true });
    await keys.search("Open as side chat");
    await user.see({ role: "option", label: /^Open as side chat/ });
    await user.press("Enter");
    await user.type(paletteTarget, world.side.title, { replace: true });
    await user.see({ role: "option", label: new RegExp(`^${world.side.title}`) });
    await user.press("Enter");
    await keys.closed();
    await focusSide();
    expect(beforeMain).toMatchObject({ id: world.main.sessionId, title: world.main.title, archived: false });
    expect(beforeOthers.map(session => ({ id: session.id, title: session.title, archived: session.archived }))).toEqual(witnesses.map(session => ({ id: session.sessionId, title: session.title, archived: false })));
    await expectPins(probe, world, false);
    await unchangedOthers();
    evidence.recordAssertionEvidence("Side focus is real but the main conversation still owns the route", `main=${world.main.sessionId}; focused side=${world.side.sessionId}; reference=${world.untouched.sessionId}; all three native GET=200, active; Pinned rows=0`, (await probe.hash()).includes(world.main.sessionId) && !beforeMain.archived && beforeOthers.every(session => !session.archived));
    await user.screenshot();
  });

  await step("after: the main row's quick Pin saves only that conversation", async () => {
    await mainRow(user, probe, world);
    const quickPin = `[data-sidebar-session-id="${world.main.sessionId}"][data-sidebar-session-workspace-id="${world.workspace.workspaceId}"] [data-session-hover-actions] button[aria-label="Pin session"]`;
    expect((await probe.dom(quickPin)).elements).toHaveLength(1);
    // Only the hovered row exposes its quick controls; use the real accessible
    // name, not CSS clicks or a fabricated test id for Pin.
    await user.click({ role: "button", label: "Pin session" });
    const saved = await expectPins(probe, world, true);
    expect((await probe.dom(`[data-global-pinned-sessions] [data-testid="sidebar-session-${world.main.sessionId}"]`)).elements).toHaveLength(1);
    expect(await nativeSession(probe, world, world.main.sessionId)).toEqual(beforeMain);
    await unchangedOthers();
    evidence.recordAssertionEvidence("Quick Pin changes only the main conversation's pinned state", `Pinned counts=${JSON.stringify(saved)}; main native identity/title/times unchanged; side and reference native records unchanged`, saved.main === 1 && saved.rows === 1 && saved.side === 0 && saved.reference === 0);
    await user.screenshot();
  });

  await step("after: the row menu unpins it and Cmd+K pins the same main conversation despite side focus", async () => {
    await user.rightClick(await mainRow(user, probe, world));
    await user.click({ role: "menuitem", label: "Unpin session" });
    const unpinned = await expectPins(probe, world, false);
    await focusSide();
    const row = await mainAction("Pin session");
    await user.press("Enter");
    await keys.closed();
    const saved = await expectPins(probe, world, true);
    expect(await nativeSession(probe, world, world.main.sessionId)).toEqual(beforeMain);
    await unchangedOthers();
    evidence.recordAssertionEvidence("Menu and palette reverse the same pin without retargeting to the side chat", `menu Pinned counts=${JSON.stringify(unpinned)}; palette=${row}; palette Pinned counts=${JSON.stringify(saved)}; all native conversation records unchanged`, unpinned.rows === 0 && saved.main === 1 && saved.rows === 1);
    await user.screenshot();
  });

  await step("cancelling Rename discards the edit without changing either open conversation", async () => {
    await focusSide();
    await mainAction("Rename session");
    await user.press("Enter");
    await keys.closed();
    await user.see({ role: "textbox", label: "Session name" }, { value: world.main.title });
    await user.type({ role: "textbox", label: "Session name" }, "Discard this rename", { replace: true });
    await user.click({ role: "button", label: "Cancel" });
    await user.notSee({ role: "textbox", label: "Session name" });
    const cancelled = await nativeSession(probe, world, world.main.sessionId);
    expect(cancelled).toEqual(beforeMain);
    await unchangedOthers();
    const pinned = await expectPins(probe, world, true);
    await focusSide();
    evidence.recordAssertionEvidence("Cancel is a no-op on saved identity, title, times and pinned state", `main title=${cancelled.title}; native main/side/reference records unchanged; Pinned counts=${JSON.stringify(pinned)}; main route and side pane retained`, JSON.stringify(cancelled) === JSON.stringify(beforeMain) && pinned.main === 1);
    await user.screenshot();
  });

  await step("after: quick Archive files only the pinned main conversation and its history stays readable", async () => {
    await focusSide();
    await mainRow(user, probe, world);
    const testId = `session-archive-${world.main.sessionId}`;
    expect((await probe.dom(`[data-sidebar-session-workspace-id="${world.workspace.workspaceId}"] [data-testid="${testId}"]`)).elements).toHaveLength(1);
    expect((await probe.dom(`[data-testid="${testId}"]`)).elements).toHaveLength(1);
    await user.click({ role: "button", testId, label: "Archive session" });
    const archived = await archiveState(true);
    // Archive may navigate away. Reopen the saved public history URL, never
    // renderer state, to prove this exact archived session is still readable.
    await user.navigate(mainUrl);
    await user.see({ text: "This conversation is read-only. Restore it to continue; previous work will not restart." });
    expect(await probe.hash()).toContain(world.main.sessionId);
    evidence.recordAssertionEvidence("Quick Archive retains the same saved conversation without touching the side chat", `native id=${archived.id}; title=${archived.title}; archived=${archived.archived}; Pinned rows=0 while archived; side/reference identities, titles and times unchanged; history is read-only`, archived.archived && archived.id === world.main.sessionId);
    await user.screenshot();
  });

  await step("after: Cmd+K restores it, the menu archives it, and Cmd+K restores that same conversation again", async () => {
    await mainAction("Unarchive session");
    await user.press("Enter");
    await keys.closed();
    const firstRestore = await archiveState(false);
    await user.see("composer", { editable: true });
    await user.rightClick(await mainRow(user, probe, world));
    await user.click({ role: "menuitem", label: "Archive session" });
    const menuArchive = await archiveState(true);
    await user.navigate(mainUrl);
    await user.see({ text: "This conversation is read-only. Restore it to continue; previous work will not restart." });
    await mainAction("Unarchive session");
    await user.press("Enter");
    await keys.closed();
    const restored = await archiveState(false);
    await user.see("composer", { editable: true });
    expect(await probe.hash()).toContain(world.main.sessionId);
    evidence.recordAssertionEvidence("Quick, menu and palette agree on archive identity and pin retention", `native id=${restored.id}; palette restored=${!firstRestore.archived}; menu archived=${menuArchive.archived}; palette restored again=${!restored.archived}; title and saved pin retained; side/reference records unchanged`, !firstRestore.archived && menuArchive.archived && !restored.archived);
    await user.screenshot();
  });

  await step("after: Close side chat removes only the pane and reloading retains the main pin and all saved conversations", async () => {
    // Public navigation may have remounted the workbench. Open the same saved
    // side chat again only if it is no longer attached, then witness focus.
    if ((await probe.dom(secondary)).elements.length === 0) {
      await keys.search("Open as side chat");
      await user.see({ role: "option", label: /^Open as side chat/ });
      await user.press("Enter");
      await user.type(paletteTarget, world.side.title, { replace: true });
      await user.see({ role: "option", label: new RegExp(`^${world.side.title}`) });
      await user.press("Enter");
      await keys.closed();
    }
    await focusSide();
    await keys.search("Close side chat");
    await user.see({ role: "option", label: /^Close side chat/ });
    await user.press("Enter");
    await keys.closed();
    await probe.eventually(() => probe.dom(secondary), {
      within: 10_000, label: "closing a side chat removes only its pane",
      until: value => value.elements.length === 0,
    });
    await user.see("composer", { editable: true });
    expect(await probe.hash()).toContain(world.main.sessionId);
    await unchangedOthers();
    await user.reload();
    await user.see("composer", { editable: true });
    expect(await probe.hash()).toContain(world.main.sessionId);
    expect((await probe.dom(secondary)).elements).toHaveLength(0);
    const restored = await archiveState(false);
    await user.see({ role: "button", testId: `sidebar-session-${world.main.sessionId}` });
    expect((await probe.dom(`[data-global-pinned-sessions] [data-testid="sidebar-session-${world.main.sessionId}"]`)).elements).toHaveLength(1);
    evidence.recordAssertionEvidence("Closing a side chat neither archives nor deletes it, and saved pins survive reload", `side panes=0 after close and reload; route=${restored.id}; saved pins=[main] rehydrated into Pinned; main active; side/reference GET=200 with original identity/title/times`, !restored.archived);
    await user.screenshot();
  });
});
