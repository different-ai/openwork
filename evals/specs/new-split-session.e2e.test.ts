import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { newSplitPrimary } from "../worlds/chat.ts";

const test = spec.world(newSplitPrimary);
const paletteInput = { placeholder: "Search actions, settings, and sessions…" };

type SplitFacts = {
  layoutKind: string;
  focusedPane: string;
  focusedComposerSessionId: string;
  primarySessionId: string;
  secondarySessionId: string;
  primaryWorkspaceId: string;
  secondaryWorkspaceId: string;
  primarySurfaceSessionId: string;
  secondarySurfaceSessionId: string;
  secondaryPaneWorkspaceId: string;
  secondaryPaneCount: number;
  locationHash: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSplitFacts(value: unknown): SplitFacts {
  if (!isRecord(value)) throw new Error(`Invalid split facts: ${JSON.stringify(value)}`);
  const text = (key: string) => typeof value[key] === "string" ? value[key] : "";
  return {
    layoutKind: text("layoutKind"),
    focusedPane: text("focusedPane"),
    focusedComposerSessionId: text("focusedComposerSessionId"),
    primarySessionId: text("primarySessionId"),
    secondarySessionId: text("secondarySessionId"),
    primaryWorkspaceId: text("primaryWorkspaceId"),
    secondaryWorkspaceId: text("secondaryWorkspaceId"),
    primarySurfaceSessionId: text("primarySurfaceSessionId"),
    secondarySurfaceSessionId: text("secondarySurfaceSessionId"),
    secondaryPaneWorkspaceId: text("secondaryPaneWorkspaceId"),
    secondaryPaneCount: typeof value.secondaryPaneCount === "number" ? value.secondaryPaneCount : -1,
    locationHash: text("locationHash"),
  };
}

test("new split creates fresh same-workspace secondary sessions without moving the primary; New session replaces the focused pane", async ({ world, user, agent, probe, step, place, evidence }) => {
  // The key chord belongs to the machine running the app, not the one running the spec.
  const paletteShortcut = place.kind !== "daytona" && process.platform === "darwin" ? "Meta+K" : "Control+K";
  const workspaceId = world.workspace.workspaceId;
  const primarySessionId = world.session.sessionId;

  const { primaryHash, before } = await step("the seeded session is the single primary pane", async () => {
    await probe.eventually(() => world.splitFacts(), {
      within: 60_000,
      label: "single layout on the seeded primary",
      until: (value) => {
        const facts = parseSplitFacts(value);
        return facts.layoutKind === "single" && facts.primarySessionId === primarySessionId;
      },
    });
    return { primaryHash: await probe.hash(), before: await agent.list() };
  });
  const beforeIds = before.map((session) => session.sessionId);

  await step("New session and Split view are directly available in the sidebar", async () => {
    await user.see({ role: "button", label: "New session" });
    await user.see({ role: "button", label: "New side chat" });
    await user.notSee({ role: "button", label: "Create new session" });
  });

  await step("New split in the session context menu opens a fresh secondary", async () => {
    // The sidebar row is the first place the title renders; the pane header comes later in DOM order.
    await user.rightClick({ text: world.session.title });
    await user.see({ role: "menuitem", label: "New side chat" });
    await user.click({ role: "menuitem", label: "New side chat" });
    await user.see({ text: "Side chat" });
    await user.see({ text: "New session" });
  });

  const { firstFacts, afterContextMenu } = await step("the context menu creates one same-workspace split session", async () => {
    const firstValue = await probe.eventually(() => world.splitFacts(), {
      within: 60_000,
      label: "context-menu new split layout",
      until: (value) => {
        const facts = parseSplitFacts(value);
        return facts.layoutKind === "split"
          && facts.primarySessionId === primarySessionId
          && facts.primaryWorkspaceId === workspaceId
          && facts.primarySurfaceSessionId === primarySessionId
          && /^ses_/.test(facts.secondarySessionId)
          && !beforeIds.includes(facts.secondarySessionId)
          && facts.secondaryWorkspaceId === facts.primaryWorkspaceId
          && facts.secondarySurfaceSessionId === facts.secondarySessionId
          && facts.secondaryPaneWorkspaceId === workspaceId
          && facts.secondaryPaneCount === 1
          && facts.locationHash === primaryHash;
      },
    });
    const firstFacts = parseSplitFacts(firstValue);
    await probe.eventually(() => world.splitFacts(), {
      within: 15_000,
      label: "new secondary composer receives keyboard focus",
      until: (candidate) => parseSplitFacts(candidate).focusedComposerSessionId === firstFacts.secondarySessionId,
    });
    expect(parseSplitFacts(await world.splitFacts()).focusedComposerSessionId).toBe(firstFacts.secondarySessionId);
    expect(firstFacts.layoutKind).toBe("split");
    expect(firstFacts.primarySessionId).toBe(primarySessionId);
    expect(firstFacts.primaryWorkspaceId).toBe(workspaceId);
    expect(firstFacts.primarySurfaceSessionId).toBe(primarySessionId);
    expect(firstFacts.secondarySessionId).toMatch(/^ses_/);
    expect(beforeIds).not.toContain(firstFacts.secondarySessionId);
    expect(firstFacts.secondaryWorkspaceId).toBe(firstFacts.primaryWorkspaceId);
    expect(firstFacts.secondarySurfaceSessionId).toBe(firstFacts.secondarySessionId);
    expect(firstFacts.secondaryPaneWorkspaceId).toBe(workspaceId);
    expect(firstFacts.secondaryPaneCount).toBe(1);
    expect(firstFacts.locationHash).toBe(primaryHash);
    expect(await probe.hash()).toContain(`/session/${primarySessionId}`);

    const afterContextMenu = await probe.eventually(() => agent.list(), {
      within: 60_000,
      label: "context-menu split session appears in the session list",
      until: (sessions) => sessions.length === before.length + 1
        && sessions.some((session) => session.sessionId === firstFacts.secondarySessionId),
    });
    expect(afterContextMenu).toHaveLength(before.length + 1);
    expect(afterContextMenu.map((session) => session.sessionId)).toContain(firstFacts.secondarySessionId);
    await user.screenshot();
    return { firstFacts, afterContextMenu };
  });

  await step("both split composers send to their own conversation", async () => {
    // Hold the primary's HTTP acknowledgement so the secondary must send
    // while the primary request is pending. Both requests still hit the engine.
    await probe.eval(`(() => {
      for (const pane of ["primary", "secondary"]) {
        const editor = document.querySelector('[data-workbench-pane="' + pane + '"] [contenteditable="true"][data-lexical-editor="true"]');
        if (!editor) throw new Error("Missing " + pane + " composer");
        editor.setAttribute("data-testid", pane + "-split-composer");
      }
      const originalFetch = window.fetch;
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      const timeout = setTimeout(release, 60000);
      window.__releaseSplitSend = () => {
        clearTimeout(timeout);
        release();
        window.fetch = originalFetch;
        delete window.__releaseSplitSend;
      };
      window.fetch = async (...args) => {
        const url = args[0] instanceof Request ? args[0].url : String(args[0]);
        const response = await originalFetch.apply(window, args);
        if (url.includes("/session/" + ${JSON.stringify(primarySessionId)} + "/prompt_async")) {
          window.__splitSendHeld = true;
          await held;
          delete window.__splitSendHeld;
        }
        return response;
      };
      return true;
    })()`);
    try {
      await user.type({ testId: "primary-split-composer" }, world.primaryPrompt);
      await user.press("Enter");
      await probe.eventually(() => probe.eval("window.__splitSendHeld === true"), {
        within: 15_000,
        label: "primary request is still pending when the secondary sends",
        until: (value) => value === true,
      });
      await user.type({ testId: "secondary-split-composer" }, world.secondaryPrompt);
      await user.press("Enter");
      await user.see({ text: "Secondary split received" }, { timeoutMs: 30_000 });
      expect(await probe.eval("window.__splitSendHeld === true")).toBe(true);
      await agent.run("workbench.session.focus", { sessionId: world.switchSession.sessionId });
      await probe.eventually(() => world.splitFacts(), {
        within: 15_000,
        label: "the primary pane switches while its previous request remains pending",
        until: (value) => parseSplitFacts(value).primarySessionId === world.switchSession.sessionId,
      });
      await user.type("composer", world.switchPrompt);
      await user.press("Enter");
      await user.see({ text: "Switched session received" }, { timeoutMs: 15_000 });
      expect(await probe.eval("window.__splitSendHeld === true")).toBe(true);
      expect(await probe.eval(`(() => {
        const primary = document.querySelector('[data-workbench-pane="primary"]')?.textContent ?? "";
        const secondary = document.querySelector('[data-workbench-pane="secondary"]')?.textContent ?? "";
        return primary.includes("Switched session received")
          && !primary.includes("Primary split received")
          && !secondary.includes("Switched session received");
      })()`)).toBe(true);
      evidence.recordAssertionEvidence(
        "Switching sessions during a pending send does not block the new session or cross replies",
        JSON.stringify({ pendingSessionId: primarySessionId, switchedSessionId: world.switchSession.sessionId }),
        true,
      );
      await agent.run("workbench.session.focus", { sessionId: primarySessionId });
      await probe.eventually(() => world.splitFacts(), {
        within: 15_000,
        label: "return to the original primary without replacing the secondary",
        until: (value) => parseSplitFacts(value).primarySessionId === primarySessionId
          && parseSplitFacts(value).secondarySessionId === firstFacts.secondarySessionId,
      });
    } catch (error) {
      await user.screenshot();
      throw error;
    } finally {
      await probe.eval("window.__releaseSplitSend?.(); true");
    }
    const readPaneReplies = () => probe.eval(`(() => {
      const primary = document.querySelector('[data-workbench-pane="primary"]')?.textContent ?? "";
      const secondary = document.querySelector('[data-workbench-pane="secondary"]')?.textContent ?? "";
      return primary.includes("Primary split received")
        && secondary.includes("Secondary split received")
        && !primary.includes("Secondary split received")
        && !secondary.includes("Primary split received");
    })()`);
    await probe.eventually(readPaneReplies, {
      within: 60_000,
      label: "each reply appears only in its owning split pane",
      until: (value) => value === true,
    });
    expect(await readPaneReplies()).toBe(true);
    evidence.recordAssertionEvidence(
      "Both split composers send and receive replies without crossing sessions",
      JSON.stringify({ primarySessionId, secondarySessionId: firstFacts.secondarySessionId }),
      true,
    );
  });

  await step("New split in the command palette replaces the secondary with another fresh session", async () => {
    await user.press(paletteShortcut);
    await user.see(paletteInput);
    await user.type(paletteInput, "new split", { replace: true });
    await user.see({ role: "option", label: /^New side chat/ });
    await user.type(paletteInput, "new side chat", { replace: true });
    await user.see({ role: "option", label: /^New side chat/ });
    await user.press("Enter");
    await user.see({ text: "Side chat" });
    await user.see({ text: "New session" });
  });

  const { secondFacts, afterPalette } = await step("the palette creates one more session while preserving the primary route", async () => {
    const afterContextMenuIds = afterContextMenu.map((session) => session.sessionId);
    const secondValue = await probe.eventually(() => world.splitFacts(), {
      within: 60_000,
      label: "palette new split replaces the secondary session",
      until: (value) => {
        const facts = parseSplitFacts(value);
        return facts.layoutKind === "split"
          && facts.primarySessionId === primarySessionId
          && facts.primaryWorkspaceId === workspaceId
          && facts.primarySurfaceSessionId === primarySessionId
          && /^ses_/.test(facts.secondarySessionId)
          && facts.secondarySessionId !== firstFacts.secondarySessionId
          && !afterContextMenuIds.includes(facts.secondarySessionId)
          && facts.secondaryWorkspaceId === facts.primaryWorkspaceId
          && facts.secondarySurfaceSessionId === facts.secondarySessionId
          && facts.secondaryPaneWorkspaceId === workspaceId
          && facts.secondaryPaneCount === 1
          && facts.locationHash === primaryHash;
      },
    });
    const secondFacts = parseSplitFacts(secondValue);
    await probe.eventually(() => world.splitFacts(), {
      within: 15_000,
      label: "new secondary composer receives keyboard focus",
      until: (candidate) => parseSplitFacts(candidate).focusedComposerSessionId === secondFacts.secondarySessionId,
    });
    expect(parseSplitFacts(await world.splitFacts()).focusedComposerSessionId).toBe(secondFacts.secondarySessionId);
    expect(secondFacts.layoutKind).toBe("split");
    expect(secondFacts.primarySessionId).toBe(primarySessionId);
    expect(secondFacts.primaryWorkspaceId).toBe(workspaceId);
    expect(secondFacts.primarySurfaceSessionId).toBe(primarySessionId);
    expect(secondFacts.secondarySessionId).toMatch(/^ses_/);
    expect(secondFacts.secondarySessionId).not.toBe(firstFacts.secondarySessionId);
    expect(afterContextMenuIds).not.toContain(secondFacts.secondarySessionId);
    expect(secondFacts.secondaryWorkspaceId).toBe(secondFacts.primaryWorkspaceId);
    expect(secondFacts.secondarySurfaceSessionId).toBe(secondFacts.secondarySessionId);
    expect(secondFacts.secondaryPaneWorkspaceId).toBe(workspaceId);
    expect(secondFacts.secondaryPaneCount).toBe(1);
    expect(secondFacts.locationHash).toBe(primaryHash);
    expect(await probe.hash()).toContain(`/session/${primarySessionId}`);

    const afterPalette = await probe.eventually(() => agent.list(), {
      within: 60_000,
      label: "palette split session appears in the session list",
      until: (sessions) => sessions.length === before.length + 2
        && sessions.some((session) => session.sessionId === secondFacts.secondarySessionId),
    });
    expect(afterPalette).toHaveLength(before.length + 2);
    expect(afterPalette.map((session) => session.sessionId)).toContain(secondFacts.secondarySessionId);
    await user.screenshot();
    return { secondFacts, afterPalette };
  });

  await step("the agent's server path sees the same layout", async () => {
    const currentFacts = parseSplitFacts(await world.splitFacts());
    const result = await world.agentContextViaServer();
    if (!isRecord(result)) throw new Error(`Invalid server UI context: ${JSON.stringify(result)}`);
    const context = isRecord(result.context) ? result.context : null;
    const conversations = context && isRecord(context.conversations) ? context.conversations : null;
    const layout = conversations && isRecord(conversations.layout) ? conversations.layout : null;
    expect(result.ok).toBe(true);
    expect(layout?.kind).toBe(currentFacts.layoutKind);
    expect(layout?.primarySessionId).toBe(currentFacts.primarySessionId);
    expect(layout?.secondarySessionId).toBe(currentFacts.secondarySessionId);
    expect(layout?.focused).toBe(currentFacts.focusedPane);
    evidence.recordAssertionEvidence(
      "Desktop split context reaches the agent through the server mailbox",
      `The server returned ok=true with kind=${layout?.kind}, primarySessionId=${layout?.primarySessionId}, secondarySessionId=${layout?.secondarySessionId}, and focused=${layout?.focused}, all matching the rendered split.`,
      true,
    );
  });

  await step("New session replaces the focused secondary pane", async () => {
    await agent.run("workbench.session.focus", { sessionId: secondFacts.secondarySessionId });
    await probe.eventually(() => world.splitFacts(), {
      within: 15_000,
      label: "secondary pane is focused",
      until: (value) => parseSplitFacts(value).focusedPane === "secondary",
    });
    await user.press(paletteShortcut);
    await user.see(paletteInput);
    await user.type(paletteInput, "new task", { replace: true });
    await user.see({ role: "option", label: /^New session/ });
    await user.press("Enter");
  });

  const { focusedSecondaryFacts, afterFocusedSecondary } = await step("the focused secondary is replaced while the primary route stays put", async () => {
    const previousIds = afterPalette.map((session) => session.sessionId);
    const value = await probe.eventually(() => world.splitFacts(), {
      within: 60_000,
      label: "new session replaces the focused secondary",
      until: (candidate) => {
        const facts = parseSplitFacts(candidate);
        return facts.layoutKind === "split"
          && facts.primarySessionId === primarySessionId
          && facts.primarySurfaceSessionId === primarySessionId
          && /^ses_/.test(facts.secondarySessionId)
          && facts.secondarySessionId !== secondFacts.secondarySessionId
          && !previousIds.includes(facts.secondarySessionId)
          && facts.secondarySurfaceSessionId === facts.secondarySessionId
          && facts.secondaryPaneCount === 1
          && facts.locationHash.includes(`/workspace/${workspaceId}/session/${primarySessionId}`);
      },
    });
    const focusedSecondaryFacts = parseSplitFacts(value);
    await probe.eventually(() => world.splitFacts(), {
      within: 15_000,
      label: "new secondary composer receives keyboard focus",
      until: (candidate) => parseSplitFacts(candidate).focusedComposerSessionId === focusedSecondaryFacts.secondarySessionId,
    });
    expect(parseSplitFacts(await world.splitFacts()).focusedComposerSessionId).toBe(focusedSecondaryFacts.secondarySessionId);
    expect(focusedSecondaryFacts.layoutKind).toBe("split");
    expect(focusedSecondaryFacts.primarySessionId).toBe(primarySessionId);
    expect(focusedSecondaryFacts.primarySurfaceSessionId).toBe(primarySessionId);
    expect(focusedSecondaryFacts.locationHash).toContain(`/workspace/${workspaceId}/session/${primarySessionId}`);
    expect(focusedSecondaryFacts.secondarySessionId).toMatch(/^ses_/);
    expect(previousIds).not.toContain(focusedSecondaryFacts.secondarySessionId);
    expect(focusedSecondaryFacts.secondarySurfaceSessionId).toBe(focusedSecondaryFacts.secondarySessionId);
    expect(focusedSecondaryFacts.secondaryPaneCount).toBe(1);
    const afterFocusedSecondary = await probe.eventually(() => agent.list(), {
      within: 60_000,
      label: "focused-secondary new session appears in the session list",
      until: (sessions) => sessions.length === afterPalette.length + 1,
    });
    expect(afterFocusedSecondary).toHaveLength(afterPalette.length + 1);
    return { focusedSecondaryFacts, afterFocusedSecondary };
  });

  await step("New session replaces the focused primary pane", async () => {
    await agent.run("workbench.session.focus", { sessionId: primarySessionId });
    await probe.eventually(() => world.splitFacts(), {
      within: 15_000,
      label: "primary pane is focused",
      until: (value) => parseSplitFacts(value).focusedPane === "primary",
    });
    await user.press(paletteShortcut);
    await user.see(paletteInput);
    await user.type(paletteInput, "new task", { replace: true });
    await user.see({ role: "option", label: /^New session/ });
    await user.press("Enter");
  });

  await step("the focused primary is replaced without changing the secondary", async () => {
    const value = await probe.eventually(() => world.splitFacts(), {
      within: 60_000,
      label: "new session replaces the focused primary",
      until: (candidate) => {
        const facts = parseSplitFacts(candidate);
        return facts.layoutKind === "split"
          && /^ses_/.test(facts.primarySessionId)
          && facts.primarySessionId !== primarySessionId
          && !facts.locationHash.includes(primarySessionId)
          && facts.locationHash.includes(`/workspace/${workspaceId}/session/${facts.primarySessionId}`)
          && facts.secondarySessionId === focusedSecondaryFacts.secondarySessionId
          && facts.secondaryPaneCount === 1;
      },
    });
    const focusedPrimaryFacts = parseSplitFacts(value);
    await probe.eventually(() => world.splitFacts(), {
      within: 15_000,
      label: "new primary composer receives keyboard focus",
      until: (candidate) => parseSplitFacts(candidate).focusedComposerSessionId === focusedPrimaryFacts.primarySessionId,
    });
    expect(parseSplitFacts(await world.splitFacts()).focusedComposerSessionId).toBe(focusedPrimaryFacts.primarySessionId);
    expect(focusedPrimaryFacts.primarySessionId).toMatch(/^ses_/);
    expect(focusedPrimaryFacts.primarySessionId).not.toBe(primarySessionId);
    expect(focusedPrimaryFacts.locationHash).toContain(`/workspace/${workspaceId}/session/${focusedPrimaryFacts.primarySessionId}`);
    expect(focusedPrimaryFacts.secondarySessionId).toBe(focusedSecondaryFacts.secondarySessionId);
    expect(focusedPrimaryFacts.secondaryPaneCount).toBe(1);
    const afterFocusedPrimary = await probe.eventually(() => agent.list(), {
      within: 60_000,
      label: "focused-primary new session appears in the session list",
      until: (sessions) => sessions.length === afterFocusedSecondary.length + 1,
    });
    expect(afterFocusedPrimary).toHaveLength(afterFocusedSecondary.length + 1);
  });
  await step("side chat has clear controls and closing it preserves both conversations", async () => {
    await user.see({ text: "Main chat" });
    await user.see({ role: "button", label: "Expand side chat" });
    const beforeClose = parseSplitFacts(await world.splitFacts());
    const sessionsBeforeClose = await agent.list();
    expect(await probe.eval(`(() => {
      const button = document.querySelector('[data-sidebar-new-split]');
      if (!(button instanceof HTMLButtonElement) || button.getAttribute('aria-label') !== 'Close side chat') return false;
      button.click();
      return true;
    })()`)).toBe(true);
    await probe.eventually(() => world.splitFacts(), {
      within: 15_000,
      label: "sidebar closes the side chat without replacing the main chat",
      until: (value) => parseSplitFacts(value).layoutKind === "single"
        && parseSplitFacts(value).primarySessionId === beforeClose.primarySessionId
        && parseSplitFacts(value).secondaryPaneCount === 0,
    });
    expect((await agent.list()).map((session) => session.sessionId).sort())
      .toEqual(sessionsBeforeClose.map((session) => session.sessionId).sort());
    await user.see({ role: "button", label: "New side chat" });
    await user.click({ role: "button", label: "New side chat" });
    const reopened = parseSplitFacts(await probe.eventually(() => world.splitFacts(), {
      within: 60_000,
      label: "sidebar creates a new side chat beside the same main conversation",
      until: (value) => parseSplitFacts(value).layoutKind === "split"
        && parseSplitFacts(value).primarySessionId === beforeClose.primarySessionId
        && parseSplitFacts(value).secondarySessionId !== beforeClose.secondarySessionId
        && parseSplitFacts(value).secondaryPaneCount === 1,
    }));
    await user.screenshot();
    expect(await probe.eval(`(() => {
      const button = document.querySelector('[data-workbench-pane-header="secondary"] button[aria-label="Expand side chat"]');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()`)).toBe(true);
    await probe.eventually(() => world.splitFacts(), {
      within: 30_000,
      label: "Expand makes the side conversation the full-width main chat",
      until: (value) => parseSplitFacts(value).layoutKind === "single"
        && parseSplitFacts(value).primarySessionId === reopened.secondarySessionId
        && parseSplitFacts(value).secondaryPaneCount === 0,
    });
    const remainingIds = (await agent.list()).map((session) => session.sessionId);
    expect(remainingIds).toContain(beforeClose.primarySessionId);
    expect(remainingIds).toContain(beforeClose.secondarySessionId);
    expect(remainingIds).toContain(reopened.secondarySessionId);
    evidence.recordAssertionEvidence(
      "Side chat controls close, create, and expand without deleting either conversation",
      "The sidebar changes from Close side chat to New side chat; closing preserves all session IDs, creating preserves the main pane, and Expand promotes the side conversation while retaining both saved chats.",
      true,
    );
  });
  evidence.recordAssertionEvidence(
    "New splits preserve the primary, and New session replaces only the focused pane",
    "Context-menu and command-palette splits each created one distinct same-workspace secondary session. The focused-secondary and focused-primary New session actions each preserved the opposite pane and created exactly one session.",
    true,
  );

});
