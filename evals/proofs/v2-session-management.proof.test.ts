import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { runToolTurn } from "@openwork/behaviors";
import type { MockAgentToolStep } from "@openwork/labs";
import { v2SessionManagement } from "../worlds/v2-session-management.ts";

const test = spec.world(v2SessionManagement, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["mock"] },
  needs: { commands: ["bun"] },
});

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(output: string): Record<string, unknown> {
  const decoded: unknown = JSON.parse(output);
  const value: unknown = typeof decoded === "string" ? JSON.parse(decoded) : decoded;
  if (!object(value)) throw new Error("The native tool did not return an object");
  return value;
}

function affordanceIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(affordanceIds);
  if (!object(value)) return [];
  return [
    ...(typeof value.id === "string" ? [value.id] : []),
    ...Object.values(value).flatMap(affordanceIds),
  ];
}

// V2 offers app tools through its Code Mode catalog, rather than listing each
// native function directly to the model. Exercise that shipping path.
const command = (id: string, args: Record<string, unknown>): MockAgentToolStep => ({
  tool: "execute", arguments: { code: `const result = await tools.openwork_execute(${JSON.stringify({ id, args })}); return typeof result === "string" ? JSON.parse(result) : result;` },
});

test("a member's agent organizes another v2 conversation without opening it or starting work there", async ({ world, user, probe, step, evidence }) => {
  const target = { sessionId: world.target.sessionId };
  const targetRow = `[data-session-tab-id="${world.target.sessionId}"]`;
  const pinnedTarget = `[data-global-pinned-sessions] ${targetRow}`;
  const requiredCommands = ["session.rename", "session.set_model", "session.pin", "session.archive"];
  let callerRoute = "";
  const turn = (label: string, steps: MockAgentToolStep[]) => runToolTurn({ user }, world, label, steps);
  const receipt = async (id: string) => {
    const call = (await world.calls()).findLast(call => call.tool === "execute" && typeof call.input.code === "string" && call.input.code.includes(JSON.stringify(id)));
    expect(call, `The native engine recorded ${id}`).toBeDefined();
    expect(call?.status).toBe("completed");
    expect(call?.error).toBe("");
    return parse(call?.output ?? "");
  };
  const staysInCaller = async () => {
    expect(await probe.hash()).toBe(callerRoute);
    const active = await probe.dom(`[data-session-tab-id="${world.caller.sessionId}"][data-session-tab-active="true"]`);
    expect(active.elements).toHaveLength(1);
    const targetState = await world.inspect();
    expect(targetState.messageCount).toBe(0);
    return targetState;
  };

  await user.resizeViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
  await step("given a separate conversation with planning notes and no work running", async () => {
    await user.see("composer", { editable: true });
    await user.see({ text: world.target.title });
    callerRoute = await probe.hash();
    expect(callerRoute).toContain(world.caller.sessionId);
    expect(world.engine.running).toBe(true);
    expect(world.engine.version).not.toBe("");
    const state = await staysInCaller();
    expect(state).toMatchObject({ title: world.target.title, archived: false, model: { providerId: world.providerId, modelId: world.originalModelId } });
    expect((await probe.dom(pinnedTarget)).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("The caller and idle target are separate native v2 conversations", `engine=${world.engine.version}; target=${state.title}; target messages=${state.messageCount}; caller route unchanged`, world.caller.sessionId !== state.id && state.messageCount === 0);
    await user.screenshot();
  });

  await step("after: the agent discovers chat management, renames the notes and changes their model", async () => {
    const prompt = await turn("Rename my planning notes and switch their model without opening them.", [
      { tool: "execute", arguments: { code: 'const result = await tools.openwork_context(); return typeof result === "string" ? JSON.parse(result) : result;' } },
      command("session.rename", { ...target, title: world.renamedTitle }),
      command("session.set_model", { ...target, providerId: world.providerId, modelId: world.replacementModelId }),
    ]);
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.see({ text: world.renamedTitle });
    const calls = await world.calls();
    const discovery = calls.find(call => call.tool === "execute" && typeof call.input.code === "string" && call.input.code.includes("tools.openwork_context()"));
    expect(discovery?.status).toBe("completed");
    const available = affordanceIds(parse(discovery?.output ?? ""));
    expect(available).toEqual(expect.arrayContaining(requiredCommands));
    expect(available).not.toContain("session.delete");
    expect(await receipt("session.rename")).toMatchObject({ ok: true });
    expect(await receipt("session.set_model")).toMatchObject({ ok: true, result: { model: { providerId: world.providerId, modelId: world.replacementModelId } } });
    const state = await staysInCaller();
    expect(state).toMatchObject({ title: world.renamedTitle, model: { providerId: world.providerId, modelId: world.replacementModelId }, archived: false });
    const requests = await world.modelCalls(prompt);
    const emitted = requests.filter(request => request.kind === "tool").map(request => request.toolName);
    expect(emitted).toEqual(["execute", "execute", "execute"]);
    expect(requests.some(request => request.kind === "final")).toBe(true);
    evidence.recordAssertionEvidence("Native agent tools discover and perform the edits, not the renderer's direct automation rail", `model emitted=${emitted.join(", ")}; discovered=${requiredCommands.filter(id => available.includes(id)).join(", ")}; persisted title=${state.title}; model=${String(state.model.providerId)}/${String(state.model.modelId)}; target messages=${state.messageCount}`, emitted.length === 3 && requiredCommands.every(id => available.includes(id)) && state.model.modelId === world.replacementModelId && state.messageCount === 0);
    await user.screenshot();
  });

  await step("after: the agent pins the notes at the top of the real sidebar", async () => {
    await turn("Pin my planning notes.", [command("session.pin", target)]);
    await user.see("Run task", { timeoutMs: 30_000 });
    await probe.eventually(() => probe.dom(pinnedTarget), { within: 10_000, label: "the planning notes appear in Pinned", until: value => value.elements.length === 1 });
    const pinned = await receipt("session.pin");
    expect(pinned).toMatchObject({ ok: true, result: { sessionId: world.target.sessionId, pinned: true } });
    const state = await staysInCaller();
    const rows = (await probe.dom(pinnedTarget)).elements;
    expect(rows[0]?.text).toContain(world.renamedTitle);
    evidence.recordAssertionEvidence("The pin command puts the renamed conversation in Pinned", `pinned rows=${rows.length}; title=${rows[0]?.text}; target messages=${state.messageCount}; caller route unchanged`, rows.length === 1 && state.messageCount === 0);
    await user.screenshot();
  });

  await step("after: toggling the same pin removes it, and archiving hides the idle notes", async () => {
    await turn("Unpin my planning notes and archive them.", [
      command("session.pin", target), command("session.archive", { ...target, archived: true }),
    ]);
    await user.see("Run task", { timeoutMs: 30_000 });
    expect(await receipt("session.pin")).toMatchObject({ ok: true, result: { pinned: false } });
    expect(await receipt("session.archive")).toMatchObject({ ok: true, result: { archived: true } });
    const state = await staysInCaller();
    expect(state.archived).toBe(true);
    await probe.eventually(() => probe.dom(targetRow), { within: 10_000, label: "the archived notes leave the active sidebar", until: value => value.elements.length === 0 });
    const pins = (await probe.dom(pinnedTarget)).elements.length;
    expect(pins).toBe(0);
    evidence.recordAssertionEvidence("Unpin toggles off and archive persists without running the target", `pinned rows=${pins}; native archived=${state.archived}; target messages=${state.messageCount}; caller route unchanged`, pins === 0 && state.archived && state.messageCount === 0);
    await user.screenshot();
  });

  await step("after: the agent restores the notes with their new title and model intact", async () => {
    await turn("Restore my archived planning notes without starting any work.", [command("session.archive", { ...target, archived: false })]);
    await user.see("Run task", { timeoutMs: 30_000 });
    await user.see({ text: world.renamedTitle });
    expect(await receipt("session.archive")).toMatchObject({ ok: true, result: { archived: false } });
    const state = await staysInCaller();
    expect(state).toMatchObject({ title: world.renamedTitle, archived: false, model: { providerId: world.providerId, modelId: world.replacementModelId }, messageCount: 0 });
    const rows = (await probe.dom(targetRow)).elements;
    expect(rows).toHaveLength(1);
    expect((await probe.dom(pinnedTarget)).elements).toHaveLength(0);
    evidence.recordAssertionEvidence("Restore brings the same conversation back without inference or repinning", `active sidebar rows=${rows.length}; archived=${state.archived}; title=${state.title}; model=${String(state.model.modelId)}; target messages=${state.messageCount}; caller route unchanged`, rows.length === 1 && !state.archived && state.model.modelId === world.replacementModelId && state.messageCount === 0);
    await user.screenshot();
  });

  await step("the running agent cannot archive itself or use an unrelated delete command", async () => {
    await turn("Try archiving this running conversation and deleting the planning notes.", [
      command("session.archive", { sessionId: world.caller.sessionId, archived: true }),
      { tool: "execute", arguments: { code: `try { await tools.openwork_execute(${JSON.stringify({ id: "session.delete", args: { ...target, confirmed: true } })}); return { rejected: false }; } catch (error) { return { rejected: true, error: String(error) }; }` } },
    ]);
    await user.see("Run task", { timeoutMs: 30_000 });
    const refused = await receipt("session.archive");
    expect(refused).toMatchObject({ ok: false, code: "self_archive_while_working" });
    const deletion = await receipt("session.delete");
    expect(deletion.rejected).toBe(true);
    expect(deletion.error).toContain("OpenWork command failed (400)");
    const state = await staysInCaller();
    const caller = await world.inspect(world.caller.sessionId);
    expect(caller.archived).toBe(false);
    expect(state).toMatchObject({ id: world.target.sessionId, title: world.renamedTitle, archived: false, model: { modelId: world.replacementModelId }, messageCount: 0 });
    await user.see({ text: world.renamedTitle });
    evidence.recordAssertionEvidence("The working caller stays open and the attempted delete leaves the target untouched", `self-archive code=${String(refused.code)}; delete rejected=${String(deletion.rejected)}, error=${String(deletion.error)}; caller archived=${caller.archived}; target still exists, messages=${state.messageCount}`, refused.code === "self_archive_while_working" && deletion.rejected === true && !caller.archived && state.id === world.target.sessionId && state.messageCount === 0);
    await user.screenshot();
  });
});
