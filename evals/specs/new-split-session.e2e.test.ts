import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { newSplitPrimary } from "../worlds/chat.ts";

const test = spec.world(newSplitPrimary, { timeout: 600_000 });
const paletteInput = { placeholder: "Search actions, settings, and sessions…" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitFacts(value: unknown) {
  if (!isRecord(value)) throw new Error("Missing split state");
  return {
    primary: String(value.primarySessionId), secondary: String(value.secondarySessionId),
    primaryWorkspace: String(value.primaryWorkspaceId), secondaryWorkspace: String(value.secondaryWorkspaceId),
    focused: String(value.focusedPane), panes: Number(value.secondaryPaneCount),
  };
}

test("side chats keep questions, replies, and saved splits attached to their own conversation", async ({ world, user, probe, agent, step }) => {
  const primary = world.session.sessionId;
  const workspaceId = world.workspace.workspaceId;
  const shortcut = await probe.eval(`/Mac|iPhone|iPad|iPod/.test(navigator.platform)`) ? "Meta+K" : "Control+K";
  const facts = async () => splitFacts(await world.splitFacts());
  const ids = async () => (await agent.list()).map((session) => session.sessionId).sort();
  const waitSplit = (main: string, side?: string) => probe.eventually(facts, {
    within: 30_000, label: "the selected session owns the visible split",
    until: (value) => value.primary === main && value.panes === 1
      && Boolean(value.secondary) && (side === undefined || value.secondary === side)
      && value.primaryWorkspace === workspaceId && value.secondaryWorkspace === workspaceId,
  }).catch(async (error: unknown) => {
    await user.screenshot();
    const persisted = await probe.storage("openwork.session-splits.v1");
    throw new Error(`${String(error)}; saved split: ${JSON.stringify(persisted)}`);
  });
  const send = async (pane: "primary" | "secondary", text: string) => {
    await user.type({ placeholder: "Describe your task...", nth: pane === "primary" ? 0 : 1 }, text);
    await user.press("Enter");
  };
  const pane = (which: "primary" | "secondary") => probe.eval(`(which) => {
    const root = document.querySelector('[data-workbench-pane="' + which + '"]');
    const messages = [...(root?.querySelectorAll('[data-message-role="assistant"]') ?? [])];
    return { text: root?.textContent ?? "", answer: messages.at(-1)?.innerText ?? "" };
  }`, { args: [which] });
  const answer = async (which: "primary" | "secondary", included: string, excluded: string) => {
    await probe.eventually(() => pane(which), { within: 45_000, label: `${which} receives only its own answer`,
      until: (value) => isRecord(value) && typeof value.answer === "string"
        && value.answer.includes(included) && !value.answer.includes(excluded),
    });
  };
  const palette = async (query: string, label: RegExp) => {
    await user.press(shortcut);
    await user.see(paletteInput);
    await user.type(paletteInput, query, { replace: true });
    await user.click({ role: "option", label });
    await probe.eventually(() => probe.eval(`(() => {
      const input = document.querySelector('[data-command-palette-input]');
      return !input || input.getClientRects().length === 0 || getComputedStyle(input).visibility === "hidden";
    })()`), { within: 10_000, label: "the palette closes after selecting the action", until: (value) => value === true })
      .catch(async (error: unknown) => { await user.screenshot(); throw error; });
    await user.notSee(paletteInput);
  };
  const rowTarget = async (sessionId: string): Promise<{ role: "button"; label: string; nth: number }> => {
    const target = await probe.eventually(() => probe.eval(`(id) => {
      const row = document.querySelector('[data-session-tab-id="' + id + '"]');
      const label = row?.getAttribute("aria-label");
      if (!label) return null;
      const buttons = [...document.querySelectorAll('button, [role="button"]')]
        .filter((node) => node.getAttribute("aria-label") === label);
      return { label, nth: buttons.indexOf(row) };
    }`, { args: [sessionId] }), {
      within: 15_000, label: "the saved conversation has a sidebar control",
      until: (value) => isRecord(value) && typeof value.label === "string" && typeof value.nth === "number" && value.nth >= 0,
    });
    if (!isRecord(target) || typeof target.label !== "string" || typeof target.nth !== "number") throw new Error("Missing saved conversation control");
    return { role: "button", label: target.label, nth: target.nth };
  };
  const reopen = async (sessionId: string) => {
    await user.click(await rowTarget(sessionId));
    await probe.eventually(facts, { within: 30_000, label: "clicking the saved conversation opens it",
      until: (value) => value.primary === sessionId,
    });
  };
  const preservedHistory = async (sessionId: string, ...messages: string[]) => {
    await probe.eventually(() => probe.eval(`(id) => {
      const surface = document.querySelector('[data-session-surface-id="' + id + '"]');
      return [...(surface?.querySelectorAll('[data-message-role]') ?? [])]
        .filter((node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden")
        .map((node) => node.innerText).join("\\n");
    }`, { args: [sessionId] }), {
      within: 30_000, label: "the reopened conversation renders its earlier messages",
      until: (value) => typeof value === "string" && messages.every((message) => value.includes(message)),
    });
    await probe.eventually(() => agent.run("session.read_transcript", { count: 30 }), {
      within: 30_000, label: "the reopened conversation retains its earlier messages",
      until: (value) => isRecord(value) && value.ok === true && value.sessionId === sessionId
        && messages.every((message) => JSON.stringify(value.messages).includes(message)),
    });
  };
  const before = await ids();
  await user.rightClick({ text: world.session.title });
  await user.click({ role: "menuitem", label: /^Open (a second|side) chat$/ });
  const first = await waitSplit(primary);
  expect(before).not.toContain(first.secondary);
  expect(await ids()).toEqual([...before, first.secondary].sort());

  await step("a real side-chat question appears and both panes can await different answers", async () => {
    try {
      await send("secondary", world.secondaryQuestionPrompt);
      await user.see({ text: "Which format should the side task use?" }, { timeoutMs: 45_000 });
      expect(await pane("primary")).not.toHaveProperty("text", expect.stringContaining("Which format should the side task use?"));
      await send("primary", world.primaryQuestionPrompt);
      await user.see({ text: "Which format should the main task use?" }, { timeoutMs: 45_000 });
      expect(await pane("secondary")).not.toHaveProperty("text", expect.stringContaining("Which format should the main task use?"));
      await probe.eventually(() => probe.eval(`(id) => {
        const row = document.querySelector('[data-sidebar-session-id="' + id + '"]');
        return Boolean(row?.querySelector('[data-session-side-chat] [data-session-attention-indicator]'));
      }`, { args: [primary] }), {
        within: 15_000, label: "the attached side chat shows that it needs an answer", until: (value) => value === true,
      });
      await user.screenshot();
    } catch (error) {
      await user.screenshot();
      throw error;
    }
  });

  await step("reload restores the split and both pending questions; answering one does not answer the other", async () => {
    await user.reload();
    await waitSplit(primary, first.secondary);
    await user.see({ text: "Which format should the side task use?" }, { timeoutMs: 30_000 });
    await user.see({ text: "Which format should the main task use?" });
    await user.click({ role: "button", label: /^Side checklist/ });
    await answer("secondary", "Side checklist", "Side outline");
    await user.see({ text: "Which format should the main task use?" });
    expect(await pane("primary")).not.toHaveProperty("answer", expect.stringContaining("Side checklist"));
    await user.click({ role: "button", label: /^Main outline/ });
    await answer("primary", "Main outline", "Main checklist");
    expect(await pane("secondary")).not.toHaveProperty("answer", expect.stringContaining("Main outline"));
    await user.screenshot();
  });

  await step("only the side conversation receives its main conversation reference", async () => {
    await send("secondary", world.contextPrompt);
    await answer("secondary", primary, "No system instructions");
    expect(await pane("secondary")).toHaveProperty("answer", expect.stringContaining("Main conversation reference"));
    await send("primary", world.contextPrompt);
    await answer("primary", "User context:", "Main conversation reference");
  });

  await step("the split belongs to the session row and follows it into Pinned", async () => {
    const rowLayout = () => probe.eval(`(id) => {
      const row = document.querySelector('[data-sidebar-session-id="' + id + '"]');
      const main = row?.querySelector('[data-session-tab-id]')?.getBoundingClientRect();
      const side = row?.querySelector('[data-session-side-chat]')?.getBoundingClientRect();
      const headers = [...document.querySelectorAll('[data-workbench-pane-header]')];
      return {
        attached: Boolean(main && side && side.left >= main.right - 1 && Math.abs(main.top - side.top) < 2),
        pinned: Boolean(row?.closest('[data-global-pinned-sessions]')),
        compactHeaders: headers.length === 2 && headers.every((node) => node.getBoundingClientRect().height <= 44),
        oldControls: document.querySelectorAll('[data-session-tab-split-pill], [data-sidebar-new-split], [data-second-chat-intro], [data-chat-composer-label]').length,
      };
    }`, { args: [primary] });
    expect(await rowLayout()).toMatchObject({ attached: true, pinned: false, compactHeaders: true, oldControls: 0 });
    await user.rightClick(await rowTarget(primary));
    await user.screenshot();
    await user.click({ role: "menuitem", label: /^Pin session$/ });
    await probe.eventually(rowLayout, { within: 15_000, label: "the session and its side-chat control move into Pinned",
      until: (value) => isRecord(value) && value.pinned === true && value.attached === true,
    });
    await user.screenshot();
  });

  await step("each session restores its own side chat and closing one preserves both histories", async () => {
    await user.click({ text: world.switchSession.title });
    await probe.eventually(facts, { within: 30_000, label: "another session opens without inheriting the split",
      until: (value) => value.primary === world.switchSession.sessionId && value.panes === 0,
    });
    await user.click({ role: "button", label: "Open side chat" });
    const other = await waitSplit(world.switchSession.sessionId);
    expect(other.secondary).not.toBe(first.secondary);
    await user.click({ role: "button", label: `Side chat · ${world.session.title}` });
    await waitSplit(primary, first.secondary);
    await probe.eventually(facts, { within: 15_000, label: "the attached side-chat button focuses the side pane", until: (value) => value.focused === "secondary" });
    await user.click({ role: "button", label: `Side chat · ${world.switchSession.title}` });
    await waitSplit(other.primary, other.secondary);
    await send("secondary", world.secondaryPrompt);
    await answer("secondary", "Secondary split received", "Primary split received");
    await send("primary", world.primaryPrompt);
    await answer("primary", "Primary split received", "Secondary split received");
    const saved = await ids();
    await user.click({ role: "button", label: "Close side chat" });
    await probe.eventually(facts, { within: 15_000, label: "closing the side pane keeps its owner open", until: (value) => value.primary === other.primary && value.panes === 0 });
    expect(await ids()).toEqual(saved);
    await preservedHistory(other.primary, world.primaryPrompt, "Primary split received");
    await reopen(other.secondary);
    await preservedHistory(other.secondary, world.secondaryPrompt, "Secondary split received");
    await user.click({ role: "button", label: `Side chat · ${world.session.title}` });
    await waitSplit(primary, first.secondary);
    await user.reload();
    await waitSplit(primary, first.secondary);
  });

  await step("palette creation replaces the focused side pane without moving the main conversation", async () => {
    await palette("new split", /^Open side chat/);
    const second = await waitSplit(primary);
    expect(second.secondary).not.toBe(first.secondary);
    expect(await ids()).toContain(first.secondary);
    await user.click({ placeholder: "Describe your task...", nth: 1 });
    await palette("new task", /^New session/);
    const third = await probe.eventually(facts, { within: 30_000, label: "New session replaces only the focused side conversation",
      until: (value) => value.primary === primary && value.secondary !== second.secondary && value.panes === 1,
    });
    expect(await ids()).toContain(second.secondary);
    await send("secondary", world.secondaryPrompt);
    await answer("secondary", "Secondary split received", "Primary split received");
    await send("primary", world.primaryPrompt);
    await answer("primary", "Primary split received", "Secondary split received");
    const context = await world.agentContextViaServer();
    expect(context).toMatchObject({ ok: true, context: { conversations: { layout: { primarySessionId: primary, secondarySessionId: third.secondary } } } });
    await user.click({ placeholder: "Describe your task...", nth: 0 });
    await palette("new task", /^New session/);
    await probe.eventually(facts, { within: 30_000, label: "New session in the main pane starts a separate conversation",
      until: (value) => value.primary !== primary && value.panes === 0,
    });
    await user.click({ role: "button", label: `Side chat · ${world.session.title}` });
    await waitSplit(primary, third.secondary);
    const saved = await ids();
    await user.click({ role: "button", label: "Open as main chat" });
    await probe.eventually(facts, { within: 30_000, label: "the side conversation opens on its own",
      until: (value) => value.primary === third.secondary && value.panes === 0,
    });
    expect(await ids()).toEqual(saved);
    await preservedHistory(third.secondary, world.secondaryPrompt, "Secondary split received");
    await reopen(first.secondary);
    await preservedHistory(first.secondary, world.secondaryQuestionPrompt, "Side checklist", world.contextPrompt);
    await reopen(primary);
    await preservedHistory(primary, world.primaryQuestionPrompt, "Main outline", world.primaryPrompt, "Primary split received");
    await user.screenshot();
  });

  await step("deleting a conversation clears its saved split and keeps the other conversation usable", async () => {
    await palette("new split", /^Open side chat/);
    const pair = await waitSplit(primary);
    await user.rightClick(await rowTarget(primary));
    await user.screenshot();
    await user.click({ role: "menuitem", label: "Delete session" });
    await user.see({ text: "Delete session?" });
    await user.click({ role: "button", label: "Delete" });
    await probe.eventually(ids, { within: 30_000, label: "only the explicitly deleted conversation is removed",
      until: (value) => !value.includes(primary) && value.includes(pair.secondary),
    });
    await probe.eventually(() => probe.storage("openwork.session-splits.v1"), {
      within: 15_000, label: "the saved split no longer references the deleted conversation",
      until: (value) => isRecord(value) && !JSON.stringify(value).includes(primary),
    });
    await reopen(pair.secondary);
    await send("primary", world.secondaryPrompt);
    await preservedHistory(pair.secondary, world.secondaryPrompt, "Secondary split received");
    await user.screenshot();
  });
});
