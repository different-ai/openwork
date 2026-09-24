import { expect } from "vitest";
import {
  compileVerification, runVerification, spec,
  type VerificationDictionary, type VerificationEvaluationRequest,
  type VerificationEvaluator, type VerificationObservation, type VerificationPlan,
} from "@openwork/testkit";
import { archivedSessionSort } from "../worlds/archived-session-sort.ts";

const test = spec.world(archivedSessionSort, {
  resources: { surfaces: ["appWeb"], services: [] },
  needs: { commands: ["bun", "pnpm"], placement: "local" },
  timeout: 240_000,
});

const archivedIntent = "Verify the archive banner is visible, the composer is absent, the native session is archived, and the owning session route is open.";
const restoredIntent = "Verify the composer is editable.";
const unsupportedIntent = "Verify the session was exported to a PDF file.";
const archivedChecks = ["archive-banner", "composer-absent", "native-archived", "owning-route"];

test("Archived is globally ordered by archive time across workspace reorder, reload, restore and rearchive", async ({ world, user, agent, probe, step }) => {
  const { newest, oldest, tieA, tieA2, tieB, active, workspaceA, workspaceB } = world;
  const ties = [tieA, tieA2, tieB].sort((a, b) => {
    if (a.workspaceId !== b.workspaceId) return a.workspaceId < b.workspaceId ? -1 : 1;
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });
  const expected = [newest, ...ties, oldest];
  const dictionary: VerificationDictionary = {
    id: "archived-session-sort", version: "1",
    checks: [
      { id: "archive-banner", description: "The archive banner is visible", assertion: { kind: "see", target: { testId: "archived-session" } } },
      { id: "composer-absent", description: "The archived session has no composer", assertion: { kind: "notSee", target: "composer" } },
      { id: "native-archived", description: "The opened session has a positive native archive timestamp", assertion: {
        kind: "observe", observation: { id: "opened-session-metadata", version: "1" }, path: ["archived"], predicate: { kind: "atLeast", value: 1 },
      } },
      { id: "owning-route", description: "The route identifies the opened archive and its owning workspace", assertion: {
        kind: "observe", observation: { id: "opened-session-route", version: "1" }, path: [],
        predicate: { kind: "equals", value: `/workspace/${oldest.workspaceId}/session/${oldest.sessionId}` },
      } },
      { id: "composer-editable", description: "The restored session composer is editable", assertion: { kind: "see", target: "composer", options: { editable: true } } },
    ],
  };
  let evaluatorCalls = 0;
  // Offline selection fixture: only these exact requests are supported; never call live Jev.
  const evaluate: VerificationEvaluator = async ({ state, questions }: VerificationEvaluationRequest) => {
    evaluatorCalls++;
    const selected = state.intent === archivedIntent ? archivedChecks
      : state.intent === restoredIntent ? ["composer-editable"] : [];
    return { answers: Object.fromEntries(Object.keys(questions).map(id => {
      const check = state.dictionary.checks.find((_, index) => id === `check_${index}`);
      return [id, { type: "boolean", probability: id === "coverage" ? Number(selected.length > 0) : Number(check !== undefined && selected.includes(check.id)) }];
    })) };
  };
  const activity: string[] = [];
  const observations: Record<string, VerificationObservation> = {
    "opened-session-metadata": { version: "1", read: async () => {
      activity.push("read:metadata");
      return world.metadata(oldest);
    } },
    "opened-session-route": { version: "1", read: async () => {
      activity.push("read:route");
      return world.route();
    } },
  };
  const channels: Parameters<typeof runVerification>[0]["channels"] = {
    user: {
      see: async (...args: Parameters<typeof user.see>) => { activity.push("see"); return user.see(...args); },
      notSee: async (...args: Parameters<typeof user.notSee>) => { activity.push("notSee"); return user.notSee(...args); },
    },
    probe,
    step: async <T>(name: string, fn: () => Promise<T> | T): Promise<T> => {
      activity.push(`step:${name}`);
      return step(name, fn);
    },
  };
  const compileOnly = async (intent: string) => {
    const before = [...activity];
    const callsBefore = evaluatorCalls;
    const result = await compileVerification({ intent, dictionary, evaluate });
    expect(activity).toEqual(before); // Compilation invokes neither fixed assertions nor bound readers.
    expect(evaluatorCalls).toBe(callsBefore + 1);
    expect(result.modelCalls).toBe(1);
    return result;
  };
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
    const tiedTimestamp = (await world.metadata(tieA)).archived;
    expect(tiedTimestamp).toBeGreaterThan(0);
    expect((await world.metadata(tieA2)).archived).toBe(tiedTimestamp);
    expect((await world.metadata(tieB)).archived).toBe(tiedTimestamp);
    expect((await world.metadata(active)).archived).toBe(0);
  });

  for (const workspaceIds of [[workspaceA.workspaceId, workspaceB.workspaceId], [workspaceB.workspaceId, workspaceA.workspaceId]]) {
    await step("a real reload consumes workspace order without changing archive recency or ties", async () => {
      await world.workspaceOrder(workspaceIds);
      await user.reload();
      await user.see({ role: "button", label: /^Archived\s+5$/ }, { timeoutMs: 90_000 });
      const first = (await probe.dom(`[data-sidebar-workspace-id="${workspaceIds[0]}"]`)).elements[0];
      const second = (await probe.dom(`[data-sidebar-workspace-id="${workspaceIds[1]}"]`)).elements[0];
      if (!first || !second) throw new Error("Both fixture workspaces must be visible in the sidebar");
      expect(first.rect.top).toBeLessThan(second.rect.top);
      await user.click({ role: "button", label: /^Archived\s+5$/ });
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
    const archived = await compileOnly(archivedIntent);
    if (archived.status !== "ready") throw new Error(`Archive verification incomplete: ${archived.reason}`);
    expect(archived.plan.checkIds).toEqual(archivedChecks);
    // JSON.parse is assigned a plan type only at this persistence boundary;
    // runVerification runtime-validates the complete plan before executing it.
    const persistedPlan: VerificationPlan = JSON.parse(JSON.stringify(archived.plan));
    const callsAfterCompile = evaluatorCalls;
    for (let replay = 0; replay < 2; replay++) {
      const start = activity.length;
      const result = await runVerification({ plan: persistedPlan, dictionary, observations, channels });
      expect(result).toMatchObject({ status: "passed", checkIds: archivedChecks, modelCalls: 0 });
      expect(activity.slice(start).filter(entry => entry.startsWith("step:"))).toEqual(
        dictionary.checks.filter(check => archivedChecks.includes(check.id)).map(check => `step:${check.description}`),
      );
      expect(activity.slice(start)).toContain("read:metadata");
      expect(activity.slice(start)).toContain("read:route");
      expect(evaluatorCalls).toBe(callsAfterCompile);
    }
    const unsupported = await compileOnly(unsupportedIntent);
    expect(unsupported.status).toBe("incomplete"); // Never execute an unsupported plan or an intentionally failing user step.
    await user.click({ role: "button", label: "Restore" });
    await user.see("composer", { editable: true });
    const restored = await compileOnly(restoredIntent);
    if (restored.status !== "ready") throw new Error(`Restore verification incomplete: ${restored.reason}`);
    expect(restored.plan.checkIds).toEqual(["composer-editable"]);
    const restoreStart = activity.length;
    const restoredResult = await runVerification({ plan: restored.plan, dictionary, observations, channels });
    expect(restoredResult).toMatchObject({ status: "passed", checkIds: ["composer-editable"], modelCalls: 0 });
    expect(activity.slice(restoreStart)).toEqual(["step:The restored session composer is editable", "see"]);
    expect(evaluatorCalls).toBe(3);
    await expectRows([newest, ...ties]);
    await user.see({ role: "button", label: /^Archived\s+4$/ });
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
    await user.see({ role: "button", label: /^Archived\s+5$/ }, { timeoutMs: 90_000 });
    await user.click({ role: "button", label: /^Archived\s+5$/ });
    await expectRows([oldest, newest, ...ties]);
  });
});
