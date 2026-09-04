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

  await step("New split in the session context menu opens a fresh secondary", async () => {
    // The sidebar row is the first place the title renders; the pane header comes later in DOM order.
    await user.rightClick({ text: world.session.title });
    await user.see({ role: "menuitem", label: "New split" });
    await user.click({ role: "menuitem", label: "New split" });
    await user.see({ text: "Split view" });
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

  await step("New split in the command palette replaces the secondary with another fresh session", async () => {
    await user.press(paletteShortcut);
    await user.see(paletteInput);
    await user.type(paletteInput, "new split", { replace: true });
    await user.see({ role: "option", label: /^New split/ });
    await user.press("Enter");
    await user.see({ text: "Split view" });
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
  evidence.recordAssertionEvidence(
    "New splits preserve the primary, and New session replaces only the focused pane",
    "Context-menu and command-palette splits each created one distinct same-workspace secondary session. The focused-secondary and focused-primary New session actions each preserved the opposite pane and created exactly one session.",
    true,
  );

});
