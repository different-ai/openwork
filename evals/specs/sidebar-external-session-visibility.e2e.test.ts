import { expect } from "vitest";
import { sleep, spec } from "@openwork/testkit";
import { externalSessionVisibility } from "../worlds/session-shell.ts";
import type { SidebarRouteFacts } from "../worlds/session-shell.ts";

/**
 * ACCEPTANCE TAPE — a session created outside the desktop window (an agent's
 * server-side `session.create`, the CLI, another client) reaches the sidebar
 * of a workspace that is not selected.
 *
 * The desktop only receives engine events for the selected workspace and used
 * to fetch every other workspace's session list exactly once per app
 * lifetime, so such a session stayed invisible — even after clicking the
 * workspace — until a full reload. Two paths now surface it:
 *   1. `workspace.reload_sessions`, which the server-side session.create
 *      affordance issues through the UI bridge right after creating sessions;
 *   2. selecting the workspace, which refetches its list every time.
 */

const test = spec.world(externalSessionVisibility);

// Quiet window that outlasts the sidebar's single 3s "empty list" retry, so a
// session that shows up afterwards can only have arrived through the path
// under test.
const EMPTY_LIST_RETRY_SETTLE_MS = 4_500;
const STALE_OBSERVATION_MS = 2_000;

type World = Awaited<ReturnType<typeof externalSessionVisibility>>;

function sessionIds(route: SidebarRouteFacts, workspaceId: string): string[] {
  return (route.sessionsByWorkspaceId[workspaceId] ?? []).map((session) => session.id);
}

function sessionTitle(route: SidebarRouteFacts, workspaceId: string, sessionId: string): string | undefined {
  return route.sessionsByWorkspaceId[workspaceId]?.find((session) => session.id === sessionId)?.title;
}

async function expectStillHidden(world: World, workspaceId: string, sessionId: string): Promise<void> {
  const deadline = Date.now() + STALE_OBSERVATION_MS;
  while (Date.now() < deadline) {
    const route = await world.route();
    expect(sessionIds(route, workspaceId)).not.toContain(sessionId);
    await sleep(250);
  }
}

test("sessions created outside the window appear in a non-selected workspace's sidebar", { timeout: 15 * 60_000 }, async ({ world, user, agent, probe, step, evidence }) => {
  const homeId = world.home.workspaceId;
  const otherId = world.other.workspaceId;

  const { homeName, otherName } = await step("both workspaces are listed with their session lists loaded", async () => {
    const route = await probe.eventually(() => world.route(), {
      within: 90_000,
      intervalMs: 250,
      label: "both workspace session lists loaded",
      until: (facts) => [homeId, otherId].every((id) => {
        const workspace = facts.workspaces.find((item) => item.id === id);
        return Boolean(workspace) && workspace?.loading === false && workspace?.error === null;
      }),
    });
    const homeName = route.workspaces.find((workspace) => workspace.id === homeId)?.name ?? "";
    const otherName = route.workspaces.find((workspace) => workspace.id === otherId)?.name ?? "";
    expect(homeName).not.toBe("");
    expect(otherName).not.toBe("");
    expect(otherName).not.toBe(homeName);
    return { homeName, otherName };
  });

  // Mirror the incident: the user keeps working in the first workspace while
  // the second one, registered a moment ago, receives sessions from elsewhere.
  await step("the user returns to the home workspace", async () => {
    await user.click({ role: "button", label: homeName });
    await probe.eventually(() => world.route(), {
      within: 60_000,
      intervalMs: 250,
      label: "home workspace selected",
      until: (route) => route.selectedWorkspaceId === homeId,
    });
    await sleep(EMPTY_LIST_RETRY_SETTLE_MS);
  });
  const homeSessionsBefore = sessionIds(await world.route(), homeId);

  // --- Path 1: an explicit reload request, as issued by session.create. ---
  await using homeEvents = world.engine === "v2" ? await world.observeWorkspaceEvents(homeId) : null;
  await using otherEvents = world.engine === "v2" ? await world.observeWorkspaceEvents(otherId) : null;
  const reloadedTitle = "External session surfaced by reload";
  // Only the v2 create dialect accepts a location in its JSON body.
  const reloadedId = await world.createSessionOutsideWindow(otherId, reloadedTitle, world.engine === "v2" ? world.homePath : undefined);
  expect(await world.serverSessionIds(otherId)).toContain(reloadedId);
  expect(await world.serverSessionIds(homeId)).not.toContain(reloadedId);
  evidence.recordAssertionEvidence(
    "workspace session list excludes another workspace's session at the server boundary",
    `Direct authenticated ${world.engine} list responses include ${reloadedId} only through its own workspace mount${world.engine === "v2" ? "; the create request supplied a conflicting home-directory location" : ""}.`,
    true,
  );
  await step("the external session is not yet visible", async () => {
    await expectStillHidden(world, otherId, reloadedId);
    await user.notSee({ text: reloadedTitle });
  });

  if (homeEvents && otherEvents) {
    await probe.eventually(() => otherEvents.snapshot(), {
      within: 15_000, intervalMs: 250, label: "own workspace event stream receives the external session",
      until: (text) => text.includes(reloadedId),
    });
    expect(homeEvents.snapshot()).not.toContain(reloadedId);
    evidence.recordAssertionEvidence(
      "the server filters workspace event streams even when clients supply a conflicting directory",
      "The direct authenticated stream for the session's workspace received its creation event; the simultaneously open home-workspace stream did not contain its ID after the observation window. Both requests supplied the other directory as a query hint.",
      true,
    );
  }

  await agent.run("workspace.reload_sessions", { workspaceId: otherId });
  const afterReload = await probe.eventually(() => world.route(), {
    within: 30_000,
    intervalMs: 250,
    label: "reloaded workspace lists the external session",
    until: (route) => sessionIds(route, otherId).includes(reloadedId),
  });
  expect(sessionTitle(afterReload, otherId, reloadedId)).toBe(reloadedTitle);
  await user.see({ text: reloadedTitle }, { timeoutMs: 30_000 });
  expect(afterReload.selectedWorkspaceId).toBe(homeId);
  expect(sessionIds(afterReload, homeId)).toEqual(homeSessionsBefore);
  evidence.recordAssertionEvidence(
    "workspace.reload_sessions surfaces a session created outside the window without selecting its workspace",
    `Session ${reloadedId} was absent for ${STALE_OBSERVATION_MS}ms, then appeared under ${otherName} with its title after the reload, the selection stayed on ${homeName} and its ${homeSessionsBefore.length} session(s) were unchanged.`,
    true,
  );

  // --- Path 2: selecting the workspace refetches its list. ---
  const selectedTitle = "External session surfaced by selection";
  const selectedId = await world.createSessionOutsideWindow(otherId, selectedTitle);
  await step("the second external session is not yet visible", async () => {
    await expectStillHidden(world, otherId, selectedId);
    await user.notSee({ text: selectedTitle });
  });

  await user.click({ role: "button", label: otherName });
  const afterSelect = await probe.eventually(() => world.route(), {
    within: 30_000,
    intervalMs: 250,
    label: "selected workspace lists the external session",
    until: (route) => route.selectedWorkspaceId === otherId && sessionIds(route, otherId).includes(selectedId),
  });
  expect(sessionTitle(afterSelect, otherId, selectedId)).toBe(selectedTitle);
  await user.see({ text: selectedTitle }, { timeoutMs: 30_000 });
  await user.see({ text: reloadedTitle });
  expect(sessionIds(afterSelect, homeId)).toEqual(homeSessionsBefore);
  evidence.recordAssertionEvidence(
    "Selecting a workspace refetches its session list and reveals sessions created outside the window",
    `Session ${selectedId} was absent for ${STALE_OBSERVATION_MS}ms while ${homeName} was selected, then appeared under ${otherName} once it was selected; the earlier session ${reloadedId} stayed listed and ${homeName}'s list was unchanged.`,
    true,
  );

  if (world.engine === "v2") {
    await step("an external native fork appears live without refetching or changing its source", async () => {
      await sleep(EMPTY_LIST_RETRY_SETTLE_MS);
      await using events = await world.observeWorkspaceEvents(otherId);
      const fork = await world.forkSessionOutsideWindow(otherId, selectedId);
      expect(fork.title).toBe(`${selectedTitle} (fork #1)`);
      expect(fork.sourceAfter).toEqual(fork.sourceBefore);
      const afterFork = await probe.eventually(() => world.route(), {
        within: 30_000, intervalMs: 250, label: "external fork discovered by the selected workspace stream",
        until: (route) => sessionIds(route, otherId).includes(fork.id),
      });
      expect(sessionIds(afterFork, otherId).filter((id) => id === fork.id)).toHaveLength(1);
      expect(sessionTitle(afterFork, otherId, fork.id)).toBe(fork.title);
      expect(sessionTitle(afterFork, otherId, selectedId)).toBe(selectedTitle);
      expect(sessionIds(afterFork, homeId)).toEqual(homeSessionsBefore);
      expect(afterFork.selectedWorkspaceId).toBe(otherId);
      await user.see({ text: fork.title });
      await user.see({ text: selectedTitle });
      const nativeEvents = await probe.eventually(() => events.snapshot(), {
        within: 15_000, intervalMs: 250, label: "native fork event observed",
        until: (text) => text.includes(fork.id),
      });
      const payloads = nativeEvents.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)));
      expect(payloads).toEqual(expect.arrayContaining([expect.objectContaining({
        type: "session.forked", data: expect.objectContaining({ sessionID: fork.id, parentID: selectedId }),
      })]));
      expect(payloads).not.toEqual(expect.arrayContaining([expect.objectContaining({ type: "session.created" })]));
      evidence.recordAssertionEvidence(
        "external v2 forks appear once with the authoritative title, without refetching or changing the source or another workspace",
        "The native stream emitted session.forked, not session.created. Its new identity appeared as a visible root conversation while the source metadata, exported history, source title, workspace selection, and other workspace list remained unchanged.",
        true,
      );
    });
  }
});
