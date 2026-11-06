import { expect } from "vitest";
import { spec, type Probe, type User } from "@openwork/testkit";
import { cmdkSessionActionParity } from "../worlds/cmdk-session-action-parity.ts";

const test = spec.world(cmdkSessionActionParity, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { commands: ["bun"] },
});

const paletteInput = "[data-command-palette-input]";
const paletteTarget = { role: "combobox" } satisfies Parameters<User["type"]>[0];
const paletteRows = "[data-command-palette-item]";
const secondary = '[data-workbench-pane="secondary"]';
const groupPrompt = "Name this group (e.g. Done, In progress):";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyboard(user: User, probe: Probe) {
  let chord = "Meta+k";
  let resolved = false;
  const open = async () => {
    await user.press(chord);
    if (!resolved) {
      const opened = await probe.eventually(() => probe.dom(paletteInput), {
        within: 1_500, label: "Cmd+K opens search on macOS",
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
      within: 5_000, label: "keyboard search receives focus",
      until: value => value.elements.some(element => element.focused),
    });
  };
  const search = async (text: string) => {
    await open();
    await user.type(paletteTarget, text, { replace: true });
  };
  const groups = async () => {
    await search("Move to group");
    await user.see({ role: "option", text: /^Move to group/i });
    await user.press("Enter");
    await user.see({ placeholder: "Search groups..." });
  };
  const closed = async () => {
    await probe.eventually(() => probe.dom(paletteInput), {
      within: 5_000, label: "search closes before the next surface opens",
      until: value => value.elements.length === 0,
    });
  };
  return { open, search, groups, closed };
}

async function readSession(probe: Probe, workspaceId: string, sessionId: string) {
  const response = await probe.desktopApi(`/workspace/${encodeURIComponent(workspaceId)}/opencode2/api/session/${encodeURIComponent(sessionId)}`);
  expect(response.status).toBe(200);
  const session = record(response.body) && "data" in response.body ? response.body.data : response.body;
  if (!record(session) || !record(session.time)) throw new Error("The native session response has no identity or times");
  expect(session.id).toBe(sessionId);
  return {
    id: session.id,
    title: session.title,
    archived: typeof session.time.archived === "number" && session.time.archived > 0,
  };
}

async function preserved(probe: Probe, world: Awaited<ReturnType<typeof cmdkSessionActionParity>>) {
  const sessions = await Promise.all([world.side, world.untouched].map(session => readSession(probe, world.workspace.workspaceId, session.sessionId)));
  expect(sessions).toEqual([
    { id: world.side.sessionId, title: world.side.title, archived: false },
    { id: world.untouched.sessionId, title: world.untouched.title, archived: false },
  ]);
  return sessions;
}

// Fresh stores give this story zero groups without writing renderer state.
// The other two native conversations are wrong-target/deletion witnesses.
test("a member organizes and safely removes the main conversation from Cmd+K even while a side chat has focus", async ({ world, user, probe, step, evidence }) => {
  const keys = keyboard(user, probe);
  const mainPath = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/session/${encodeURIComponent(world.main.sessionId)}`;
  const mainUrl = new URL(mainPath, world.app.webUrl).href;
  await user.resizeViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });

  await step("after: keyboard search offers Archive for the named main conversation", async () => {
    await user.see("composer", { editable: true });
    expect(await probe.hash()).toContain(world.main.sessionId);
    await keys.search("Archive session");
    await user.see({ role: "option", text: /^Archive session/ });
    const archive = (await probe.dom(paletteRows)).elements.find(element => element.text.startsWith("Archive session"));
    expect(archive?.text).toContain(world.main.title);
    await preserved(probe, world);
    evidence.recordAssertionEvidence("Archive identifies the main conversation before anything is changed", `target=${world.main.title}; owner=${world.workspace.workspaceId}; row=${archive?.text}; two other conversations unchanged`, Boolean(archive?.text.includes(world.main.title)));
    await user.screenshot();
    await user.press("Escape");
    await keys.closed();
  });

  await step("after: a workspace with zero groups still offers No group and New group", async () => {
    expect((await probe.dom("[data-session-group]")).elements).toHaveLength(0);
    await keys.groups();
    await user.see({ role: "option", text: /^No group/ });
    await user.see({ role: "option", text: /^New group/ });
    const disabled = (await probe.dom(`${paletteRows}[aria-disabled="true"], ${paletteRows}[data-disabled]`)).elements;
    expect(disabled.some(element => element.text.startsWith("No group"))).toBe(true);
    evidence.recordAssertionEvidence("An empty group picker is useful and cannot ungroup an already ungrouped conversation", `groups=0; No group disabled=${disabled.some(element => element.text.startsWith("No group"))}; New group visible`, disabled.some(element => element.text.startsWith("No group")));
    await user.screenshot();
  });

  await step("the member can cancel creating the first group without changing any conversation", async () => {
    await user.type(paletteTarget, "New group", { replace: true });
    await user.press("Enter");
    await user.see({ placeholder: groupPrompt }, { editable: true });
    await keys.closed();
    await user.type({ placeholder: groupPrompt }, "Cancelled review group");
    await user.screenshot();
    await user.click({ role: "button", label: "Cancel" });
    await user.notSee({ placeholder: groupPrompt });
    const groups = (await probe.dom("[data-session-group]")).elements;
    expect(groups).toHaveLength(0);
    const others = await preserved(probe, world);
    const main = await readSession(probe, world.workspace.workspaceId, world.main.sessionId);
    expect(main.archived).toBe(false);
    evidence.recordAssertionEvidence("Cancel creates no group and leaves all three conversations saved", `groups=${groups.length}; main active=${!main.archived}; preserved conversations=${others.length}`, groups.length === 0 && !main.archived && others.length === 2);
    await user.screenshot();
  });

  await step("after: New group creates an empty group without silently moving the main conversation", async () => {
    await keys.groups();
    await user.type(paletteTarget, "New group", { replace: true });
    await user.press("Enter");
    await user.see({ placeholder: groupPrompt }, { editable: true });
    await keys.closed();
    await user.type({ placeholder: groupPrompt }, world.groupName);
    await user.click({ role: "button", label: "Save" });
    await user.notSee({ placeholder: groupPrompt });
    await keys.groups();
    await user.see({ role: "option", text: new RegExp(`^${world.groupName}`) });
    const noGroup = (await probe.dom(`${paletteRows}[aria-disabled="true"], ${paletteRows}[data-disabled]`)).elements.find(element => element.text.startsWith("No group"));
    expect(noGroup).toBeDefined();
    const groupHeaders = (await probe.dom("[data-session-group]")).elements;
    expect(groupHeaders).toHaveLength(1);
    expect(groupHeaders[0]?.text).toContain(world.groupName);
    evidence.recordAssertionEvidence("Creating a group is create-only", `created=${world.groupName}; groups=${groupHeaders.length}; No group remains selected/disabled`, Boolean(noGroup));
    await user.screenshot();
    await user.press("Escape");
    await user.press("Escape");
    await keys.closed();
  });

  await step("after: choosing a group moves the main conversation and No group clears it again", async () => {
    await keys.groups();
    await user.type(paletteTarget, world.groupName, { replace: true });
    await user.press("Enter");
    await keys.closed();
    await keys.groups();
    const assigned = (await probe.dom(`${paletteRows}[aria-disabled="true"], ${paletteRows}[data-disabled]`)).elements.find(element => element.text.startsWith(world.groupName));
    expect(assigned).toBeDefined();
    await user.screenshot();
    await user.type(paletteTarget, "No group", { replace: true });
    await user.press("Enter");
    await keys.closed();
    await keys.groups();
    const ungrouped = (await probe.dom(`${paletteRows}[aria-disabled="true"], ${paletteRows}[data-disabled]`)).elements.find(element => element.text.startsWith("No group"));
    expect(ungrouped).toBeDefined();
    await preserved(probe, world);
    evidence.recordAssertionEvidence("Group assignment and ungrouping are explicit, reversible choices", `assigned=${Boolean(assigned)}; then No group selected=${Boolean(ungrouped)}; other conversations unchanged`, Boolean(assigned && ungrouped));
    await user.screenshot();
    await user.press("Escape");
    await user.press("Escape");
    await keys.closed();
  });

  await step("the member focuses a saved side chat while the main conversation remains the route", async () => {
    await keys.search("Open as side chat");
    await user.see({ role: "option", text: /^Open as side chat/ });
    await user.press("Enter");
    await user.type(paletteTarget, world.side.title, { replace: true });
    await user.see({ role: "option", text: new RegExp(`^${world.side.title}`) });
    await user.press("Enter");
    await keys.closed();
    await user.see({ role: "textbox", nth: 1 }, { editable: true });
    await user.click({ role: "textbox", nth: 1 });
    const focus = await probe.dom(`${secondary}[data-workbench-pane-focused="true"][data-workbench-workspace-id="${world.workspace.workspaceId}"]`);
    expect(focus.elements).toHaveLength(1);
    expect(await probe.hash()).toContain(world.main.sessionId);
    expect((await probe.dom('[data-workbench-pane-header="secondary"]')).elements[0]?.text).toContain(world.side.title);
    evidence.recordAssertionEvidence("The risky focus condition really occurs", `focused=side; side=${world.side.title}; route=main; owner=${world.workspace.workspaceId}`, focus.elements.length === 1 && (await probe.hash()).includes(world.main.sessionId));
    await user.screenshot();
  });

  await step("after: Delete names the main conversation, not the focused side chat, and waits for consent", async () => {
    await keys.search("Delete session");
    await user.see({ role: "option", text: /^Delete session/ });
    const deletion = (await probe.dom(paletteRows)).elements.find(element => element.text.startsWith("Delete session"));
    expect(deletion?.text).toContain(world.main.title);
    expect(deletion?.text).not.toContain(world.side.title);
    await user.press("Enter");
    await keys.closed();
    await user.see({ role: "heading", text: "Delete session?" });
    const dialog = (await probe.dom('[role="dialog"], [role="alertdialog"]')).elements.find(element => element.text.includes("Delete session?"));
    expect(dialog?.text).toContain(world.main.title);
    expect(dialog?.text).not.toContain(world.side.title);
    expect((await readSession(probe, world.workspace.workspaceId, world.main.sessionId)).archived).toBe(false);
    await preserved(probe, world);
    evidence.recordAssertionEvidence("Selecting Delete only opens the named confirmation", `dialog=${dialog?.text}; owner=${world.workspace.workspaceId}; all three native sessions still exist`, Boolean(dialog?.text.includes(world.main.title)));
    await user.screenshot();
  });

  await step("cancelling Delete leaves the main and side conversations open and saved", async () => {
    await user.click({ role: "button", label: "Cancel" });
    await user.notSee({ role: "heading", text: "Delete session?" });
    const route = await probe.hash();
    expect(route).toContain(world.main.sessionId);
    const panes = (await probe.dom(secondary)).elements;
    expect(panes).toHaveLength(1);
    const main = await readSession(probe, world.workspace.workspaceId, world.main.sessionId);
    expect(main.title).toBe(world.main.title);
    const others = await preserved(probe, world);
    evidence.recordAssertionEvidence("Cancel means no deletion", `main route unchanged=${route.includes(world.main.sessionId)}; side panes=${panes.length}; preserved other conversations=${others.length}`, route.includes(world.main.sessionId) && panes.length === 1 && main.title === world.main.title && others.length === 2);
    await user.screenshot();
  });

  await step("Archive still names the main conversation when the member returns focus to the side chat", async () => {
    await user.click({ role: "textbox", nth: 1 });
    expect((await probe.dom(`${secondary}[data-workbench-pane-focused="true"]`)).elements).toHaveLength(1);
    await keys.search("Archive session");
    await user.see({ role: "option", text: /^Archive session/ });
    const archive = (await probe.dom(paletteRows)).elements.find(element => element.text.startsWith("Archive session"));
    expect(archive?.text).toContain(world.main.title);
    expect(archive?.text).not.toContain(world.side.title);
    evidence.recordAssertionEvidence("Side-chat focus does not retarget Archive", `row=${archive?.text}; route owner=${world.workspace.workspaceId}; main=${world.main.title}; side=${world.side.title}`, Boolean(archive?.text.includes(world.main.title)) && !archive?.text.includes(world.side.title));
    await user.screenshot();
    await user.press("Escape");
    await keys.closed();
  });

  await step("after: Close side chat closes only the pane and preserves both conversations", async () => {
    await keys.search("Close side chat");
    await user.see({ role: "option", text: /^Close side chat/ });
    await user.press("Enter");
    await keys.closed();
    const panes = await probe.eventually(() => probe.dom(secondary), { within: 10_000, label: "only the side pane closes", until: value => value.elements.length === 0 });
    await user.see("composer", { editable: true });
    const route = await probe.hash();
    expect(route).toContain(world.main.sessionId);
    const main = await readSession(probe, world.workspace.workspaceId, world.main.sessionId);
    expect(main.archived).toBe(false);
    const others = await preserved(probe, world);
    evidence.recordAssertionEvidence("Closing a side chat is not archive or delete", `side panes=${panes.elements.length}; main route unchanged=${route.includes(world.main.sessionId)}; main active=${!main.archived}; preserved other conversations=${others.length}`, panes.elements.length === 0 && route.includes(world.main.sessionId) && !main.archived && others.length === 2);
    await user.screenshot();
  });

  await step("after: Archive hides only the main conversation and Restore brings the same one back", async () => {
    await keys.search("Archive session");
    await user.see({ role: "option", text: /^Archive session/ });
    await user.press("Enter");
    await keys.closed();
    const archived = await probe.eventually(() => readSession(probe, world.workspace.workspaceId, world.main.sessionId), { within: 15_000, label: "the main conversation is archived in the native engine", until: value => value.archived });
    await preserved(probe, world);
    // Follow the same public route as an archived sidebar link. Archive may
    // navigate to a fresh task; no renderer state is set to reopen the history.
    await user.navigate(mainUrl);
    await user.see({ text: "This conversation is read-only. Restore it to continue; previous work will not restart." });
    await keys.search("Unarchive session");
    await user.see({ role: "option", text: /^Unarchive session/ });
    const restoration = (await probe.dom(paletteRows)).elements.find(element => element.text.startsWith("Unarchive session"));
    expect(restoration?.text).toContain(world.main.title);
    await user.screenshot();
    await user.press("Enter");
    await keys.closed();
    const restored = await probe.eventually(() => readSession(probe, world.workspace.workspaceId, world.main.sessionId), { within: 15_000, label: "the same native conversation is restored", until: value => !value.archived });
    expect(restored.title).toBe(world.main.title);
    await user.see("composer", { editable: true });
    await user.see({ role: "button", text: world.main.title });
    await preserved(probe, world);
    evidence.recordAssertionEvidence("Archive and Restore affect only the captured main conversation", `main archived=${archived.archived}, then restored=${!restored.archived}; id and title unchanged; side and reference stay active`, archived.archived && !restored.archived);
    await user.screenshot();
  });

  await step("after: confirming Delete removes only the named main conversation", async () => {
    await keys.search("Delete session");
    await user.see({ role: "option", text: /^Delete session/ });
    await user.press("Enter");
    await keys.closed();
    await user.see({ role: "heading", text: "Delete session?" });
    await user.see({ text: `This will permanently delete "${world.main.title}" and its messages.` });
    await user.click({ role: "button", label: "Delete" });
    await user.notSee({ role: "heading", text: "Delete session?" });
    const deleted = await probe.eventually(() => probe.desktopApi(`/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode2/api/session/${encodeURIComponent(world.main.sessionId)}`), { within: 15_000, label: "only the confirmed main conversation is deleted", until: value => value.status === 404 });
    await preserved(probe, world);
    await user.see({ role: "button", text: world.side.title });
    await user.see({ role: "button", text: world.untouched.title });
    evidence.recordAssertionEvidence("The destructive choice requires confirmation and has a bounded target", `confirmed main GET=${deleted.status}; side and reference GET=200, titles unchanged, archived=false`, deleted.status === 404);
    await user.screenshot();
  });
});

test("a member sees why Settle is unavailable and can cancel archiving a conversation that still needs an answer", async ({ world, user, probe, step, evidence }) => {
  const keys = keyboard(user, probe);
  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });

  await step("given a real conversation waiting for the member's format choice", async () => {
    await user.see("composer", { editable: true });
    await user.type("composer", world.question.prompt);
    await user.press("Enter");
    await user.see({ text: world.question.text }, { timeoutMs: 45_000 });
    await user.see({ text: world.question.answer });
    const question = (await probe.text()).includes(world.question.text);
    expect(question).toBe(true);
    await preserved(probe, world);
    evidence.recordAssertionEvidence("The unavailable action is exercised during a real native question", `question=${world.question.text}; main=${world.main.title}; two unrelated conversations unchanged`, question);
    await user.screenshot();
  });

  await step("after: Settle remains visible with its reason and Enter cannot settle the waiting conversation", async () => {
    await keys.search("Settle session");
    await user.see({ role: "option", text: /^Settle session/ });
    const disabled = (await probe.dom(`${paletteRows}[aria-disabled="true"], ${paletteRows}[data-disabled]`)).elements.find(element => element.text.startsWith("Settle session"));
    expect(disabled?.text).toContain("after it finishes");
    expect(disabled?.text).toContain(world.main.title);
    await user.press("Enter");
    await user.see(paletteTarget);
    expect((await probe.dom('[data-workspace-settled-sessions] [data-session-tab-id="' + world.main.sessionId + '"]')).elements).toHaveLength(0);
    expect((await readSession(probe, world.workspace.workspaceId, world.main.sessionId)).archived).toBe(false);
    evidence.recordAssertionEvidence("Blocked is visible, explained and cannot dispatch", `disabled row=${disabled?.text}; Enter leaves search open; waiting conversation is not settled or archived`, Boolean(disabled?.text.includes("after it finishes")));
    await user.screenshot();
    await user.press("Escape");
    await keys.closed();
    await user.see({ text: world.question.text });
  });

  await step("cancelling Stop and archive preserves the pending question and every other conversation", async () => {
    await keys.search("Archive session");
    await user.see({ role: "option", text: /^Archive session/ });
    await user.press("Enter");
    await keys.closed();
    await user.see({ role: "button", label: "Stop and archive" });
    const dialog = (await probe.dom('[role="dialog"], [role="alertdialog"]')).elements.find(element => element.text.includes("Stop and archive"));
    expect(dialog?.text).toContain(world.main.title);
    await user.screenshot();
    await user.click({ role: "button", label: "Keep session open" });
    await user.notSee({ role: "button", label: "Stop and archive" });
    await user.see({ text: world.question.text });
    const main = await readSession(probe, world.workspace.workspaceId, world.main.sessionId);
    expect(main.archived).toBe(false);
    expect(await probe.hash()).toContain(world.main.sessionId);
    await preserved(probe, world);
    evidence.recordAssertionEvidence("Cancel does not stop or archive work that still needs an answer", `pending question still visible; main archived=${main.archived}; route unchanged; two other conversations active`, !main.archived);
    await user.screenshot();
  });
});
