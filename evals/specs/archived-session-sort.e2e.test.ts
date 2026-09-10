import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { archivedSessionSort } from "../worlds/archived-session-sort.ts";

const test = spec.world(archivedSessionSort, {
  resources: { surfaces: ["appWeb"], services: [] },
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  timeout: 240_000,
});

test("Archived is globally ordered by archive time across workspace reorder, reload, restore and rearchive", async ({ world, user, agent, probe, step }) => {
  const { newest, oldest, tieA, tieB, active, workspaceA, workspaceB } = world;
  const ties = workspaceA.workspaceId < workspaceB.workspaceId ? [tieA, tieB] : [tieB, tieA];
  const expected = [newest, ...ties, oldest];
  const rowTitles = async () => (await probe.dom("[data-global-archived-sessions] [data-session-tab-id]"))
    .elements.filter(row => row.rect.width > 0 && row.rect.height > 0).map(row => row.text);
  const expectRows = async (sessions: typeof expected) => {
    const titles = sessions.map(session => session.title);
    expect(await probe.eventually(rowTitles, {
      within: 30_000, label: "visible Archived rows have the expected global order",
      until: rows => JSON.stringify(rows) === JSON.stringify(titles),
    })).toEqual(titles);
    expect(await rowTitles()).not.toContain(active.title);
  };

  await step("native archive timestamps conflict with both creation and update order", async () => {
    const recent = await world.metadata(newest);
    const old = await world.metadata(oldest);
    expect(recent.directory).toBe(world.workspacePath);
    expect(old.directory).toBe(`${world.workspacePath}/second`);
    expect(recent.archived).toBeGreaterThan(old.archived);
    expect(recent.created).toBeLessThan(old.created);
    expect(recent.updated).toBeLessThan(old.updated);
    expect((await world.metadata(tieA)).archived).toBe((await world.metadata(tieB)).archived);
    expect((await world.metadata(active)).archived).toBe(0);
  });

  for (const workspaceIds of [[workspaceA.workspaceId, workspaceB.workspaceId], [workspaceB.workspaceId, workspaceA.workspaceId]]) {
    await step("a real reload consumes workspace order without changing archive recency or ties", async () => {
      await world.workspaceOrder(workspaceIds);
      await user.reload();
      await user.see({ role: "button", label: /^Archived\s+4$/ }, { timeoutMs: 90_000 });
      const first = (await probe.dom(`[data-sidebar-workspace-id="${workspaceIds[0]}"]`)).elements[0];
      const second = (await probe.dom(`[data-sidebar-workspace-id="${workspaceIds[1]}"]`)).elements[0];
      if (!first || !second) throw new Error("Both fixture workspaces must be visible in the sidebar");
      expect(first.rect.top).toBeLessThan(second.rect.top);
      await user.click({ role: "button", label: /^Archived\s+4$/ });
      await expectRows(expected);
      await user.see({ testId: `sidebar-session-${active.sessionId}` });
    });
  }

  await step("clicking an archive opens its owning workspace and Restore removes only that row", async () => {
    await user.click({ testId: `sidebar-session-${oldest.sessionId}` });
    expect(await probe.eventually(() => world.route(), {
      within: 30_000, label: "archive click opens the owning workspace session",
      until: route => route === `/workspace/${oldest.workspaceId}/session/${oldest.sessionId}`,
    })).toBe(`/workspace/${oldest.workspaceId}/session/${oldest.sessionId}`);
    await user.see({ testId: "archived-session" });
    await user.notSee("composer");
    await user.click({ role: "button", label: "Restore" });
    await user.see("composer", { editable: true });
    await expectRows([newest, ...ties]);
    expect((await world.metadata(oldest)).archived).toBe(0);
    expect((await world.metadata(newest)).archived).toBeGreaterThan(0);
  });

  await step("rearchiving uses the new native archive timestamp and moves the restored session first", async () => {
    expect(await agent.run("session.archive", { sessionId: oldest.sessionId, archived: true })).toMatchObject({ ok: true, archived: true });
    await expectRows([oldest, newest, ...ties]);
    expect((await world.metadata(oldest)).archived).toBeGreaterThan((await world.metadata(newest)).archived);
    expect((await world.metadata(active)).archived).toBe(0);
    await user.see({ testId: `sidebar-session-${active.sessionId}` });
    await user.reload();
    await user.click({ role: "button", label: /^Archived\s+4$/ });
    await expectRows([oldest, newest, ...ties]);
  });
});
