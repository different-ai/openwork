import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { newSplitPrimary } from "../worlds/chat.ts";

const test = spec.world(newSplitPrimary);
const paletteInput = { placeholder: "Search actions, settings, and sessions…" };

type SplitFacts = {
  layoutKind: string;
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

const splitFactsExpression = `(() => {
    const context = window.__openworkControl?.context?.();
    const layout = context?.conversations?.layout;
    const primaryPane = document.querySelector('[data-workbench-pane="primary"]');
    const secondaryPanes = [...document.querySelectorAll('[data-workbench-pane="secondary"]')];
    const secondaryPane = secondaryPanes[0];
    return {
      layoutKind: layout?.kind ?? "",
      primarySessionId: layout?.primarySessionId ?? layout?.sessionId ?? "",
      secondarySessionId: layout?.secondarySessionId ?? "",
      primaryWorkspaceId: layout?.primaryWorkspaceId ?? "",
      secondaryWorkspaceId: layout?.secondaryWorkspaceId ?? "",
      primarySurfaceSessionId: primaryPane?.querySelector('[data-session-surface-id]')
        ?.getAttribute('data-session-surface-id') ?? "",
      secondarySurfaceSessionId: secondaryPane?.querySelector('[data-session-surface-id]')
        ?.getAttribute('data-session-surface-id') ?? "",
      secondaryPaneWorkspaceId: secondaryPane?.getAttribute('data-workbench-workspace-id') ?? "",
      secondaryPaneCount: secondaryPanes.length,
      locationHash: window.location.hash,
    };
  })()`;

test("new split creates fresh same-workspace secondary sessions without moving the primary", async ({ world, user, agent, probe, step, place }) => {
  // The key chord belongs to the machine running the app, not the one running the spec.
  const paletteShortcut = place.kind !== "daytona" && process.platform === "darwin" ? "Meta+K" : "Control+K";
  const workspaceId = world.workspace.workspaceId;
  const primarySessionId = world.session.sessionId;

  const { primaryHash, before } = await step("the seeded session is the single primary pane", async () => {
    await probe.eventually(() => probe.eval(`(() => {
      const layout = window.__openworkControl?.context?.().conversations?.layout;
      return layout?.kind === "single" && layout?.sessionId === ${JSON.stringify(primarySessionId)};
    })()`), {
      within: 60_000,
      label: "single layout on the seeded primary",
      until: (ready) => ready === true,
    });
    return { primaryHash: await probe.hash(), before: await agent.list() };
  });
  const beforeIds = before.map((session) => session.sessionId);

  await step("New split in the session context menu opens a fresh secondary", async () => {
    const opened = await probe.eval(`(() => {
      const row = document.querySelector(
        '[data-sidebar-session-id="${primarySessionId}"][data-sidebar-session-workspace-id="${workspaceId}"]'
      );
      if (!(row instanceof HTMLElement)) return false;
      row.scrollIntoView({ block: "center" });
      const target = row.querySelector('[data-session-tab-id="${primarySessionId}"]') ?? row;
      if (!(target instanceof HTMLElement)) return false;
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        button: 2,
        buttons: 2,
        clientX: rect.left + Math.min(24, Math.max(1, rect.width / 2)),
        clientY: rect.top + Math.min(12, Math.max(1, rect.height / 2)),
      }));
      return true;
    })()`);
    expect(opened).toBe(true);
    await user.see({ role: "menuitem", label: "New split" });
    await user.click({ role: "menuitem", label: "New split" });
  });

  const { firstFacts, afterContextMenu } = await step("the context menu creates one same-workspace split session", async () => {
    const firstValue = await probe.eventually(() => probe.eval(splitFactsExpression), {
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
  });

  await step("the palette creates one more session while preserving the primary route", async () => {
    const afterContextMenuIds = afterContextMenu.map((session) => session.sessionId);
    const secondValue = await probe.eventually(() => probe.eval(splitFactsExpression), {
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
  });
});
