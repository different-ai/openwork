import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sessionAttentionReview } from "../worlds/chat.ts";

const test = spec.world(sessionAttentionReview, { timeout: 600_000 });

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a record");
  return Object.fromEntries(Object.entries(value));
}
function records(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Expected a list");
  return value.map(record);
}

function proposalReceipt(value: unknown): Record<string, unknown> {
  const pending = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "string") {
      try { pending.push(JSON.parse(item)); } catch { /* Not a tool result. */ }
    } else if (Array.isArray(item)) pending.push(...item);
    else if (item && typeof item === "object") {
      const candidate = record(item);
      if (typeof candidate.reviewId === "string" && candidate.status === "loading") return candidate;
      pending.push(...Object.values(candidate));
    }
  }
  throw new Error("The native transcript did not contain a loading proposal receipt.");
}

test("the focused coordinator discovers other owners' blockers and stages an exact human-reviewed answer without approving a permission", async ({ world, user, agent, probe, step }) => {
  const workspaceId = world.workspace.workspaceId;
  const open = async (session: { sessionId: string; title: string }) => {
    await user.click({ testId: `sidebar-session-${session.sessionId}` });
    await probe.eventually(() => probe.hash(), { within: 30_000, label: "the intended session is focused", until: hash => hash.includes(`/session/${session.sessionId}`) });
  };
  const send = async (prompt: string) => { await user.type("composer", prompt, { verify: true }); await user.press("Enter"); };
  const attention = async (sessionId: string) => record(await agent.run("session.attention", { workspaceId, sessionId }));
  const items = (value: unknown) => records(record(value).items);
  const v2 = world.engine === "v2";
  const mount = `/workspace/${encodeURIComponent(workspaceId)}/${v2 ? "opencode2/api" : "opencode"}`;
  const native = async (path: string) => {
    const result = await probe.desktopApi(`${mount}${path}`);
    expect(result.status).toBe(200);
    return v2 ? record(result.body).data : result.body;
  };
  const pending = async () => records(await native(v2 ? "/form/request" : "/question"))
    .filter(value => value.sessionID === world.asking.sessionId);
  const permissions = async () => records(await native(v2 ? `/session/${world.permission.sessionId}/permission` : "/permission"))
    .filter(value => value.sessionID === world.permission.sessionId);

  await step("B asks a real question and C waits behind an independent real permission", async () => {
    await open(world.asking);
    await send(world.asking.prompt);
    await user.see({ text: world.asking.question }, { timeoutMs: 45_000 });
    await open(world.permission);
    await send(world.permission.prompt);
    await user.see("Allow once", { timeoutMs: 45_000 });
    await open(world.origin);
    await user.see("composer", { editable: true });
  });
  const permissionBefore = await permissions();
  expect(permissionBefore).toHaveLength(1);
  const beforeHash = await probe.hash();
  const proposal = await step("A discovers and reads B and C without navigation or cross-owner leakage", async () => {
    const listed = records(await agent.run("session.list_sessions"));
    expect(listed.find(value => value.sessionId === world.asking.sessionId)).toMatchObject({ workspaceId, activity: { freshness: "cached", questions: 1 } });
    expect(listed.find(value => value.sessionId === world.permission.sessionId)).toMatchObject({ workspaceId, activity: { freshness: "cached", permissions: 1 } });
    const b = await attention(world.asking.sessionId);
    const c = await attention(world.permission.sessionId);
    expect(items(b.questions)).toHaveLength(1);
    expect(items(b.permissions)).toEqual([]);
    expect(items(c.questions)).toEqual([]);
    expect(items(c.permissions)).toHaveLength(1);
    expect(await probe.hash()).toBe(beforeHash);
    await expect(agent.run("session.attention", { workspaceId: "missing-workspace", sessionId: world.asking.sessionId })).rejects.toThrow();
    const question = items(b.questions)[0];
    return { workspaceId, sessionId: world.asking.sessionId, requestId: question.requestId, fingerprint: question.fingerprint, answers: [[world.asking.answer]] };
  });
  const receipt = await step("the real server-stamped proposal returns before human review and cannot resume B", async () => {
    await world.prepareProposal(proposal);
    expect(world.origin.prompt).not.toContain(world.asking.sessionId);
    await send(world.origin.prompt);
    await user.see({ text: "Review question answer" }, { timeoutMs: 45_000 });
    await user.see("Send answer and resume", { timeoutMs: 30_000 });
    await user.see({ text: /Proposed by Review coordinator/ });
    await user.see({ text: /Answering Question owner/ });
    await user.see({ text: world.asking.question });
    await user.see({ text: "Proposed answer: Checklist" });
    await probe.eventually(() => world.mock.agentRequests({ promptMarker: world.origin.prompt }), {
      within: 30_000, label: "the proposing tool returns to A while the person has not clicked Send",
      until: calls => calls.some(call => call.kind === "final" && call.completedTools === 1),
    });
    const messages = await native(`/session/${world.origin.sessionId}/${v2 ? "context" : "message?limit=50"}`);
    const receipt = proposalReceipt(messages);
    expect(receipt).toMatchObject({ status: "loading", sent: false, acceptance: "not_sent",
      origin: { workspaceId, sessionId: world.origin.sessionId }, target: { workspaceId, sessionId: world.asking.sessionId } });
    expect(await agent.run("session.question.reply.status", { reviewId: receipt.reviewId, workspaceId, sessionId: world.asking.sessionId }))
      .toMatchObject({ status: "pending_review", sent: false, acceptance: "not_sent" });
    expect(await pending()).toHaveLength(1);
    expect(await permissions()).toEqual(permissionBefore);
    expect(await probe.hash()).toBe(beforeHash);
    expect((await world.mock.agentRequests({ promptMarker: world.asking.prompt })).filter(call => call.kind === "final")).toEqual([]);
    return receipt;
  });
  await step("one person click resumes only B exactly once; A stays focused and C stays blocked", async () => {
    await user.click("Send answer and resume");
    await user.see({ text: /The question reply was accepted/ }, { timeoutMs: 30_000 });
    expect(await agent.run("session.question.reply.status", { reviewId: receipt.reviewId, workspaceId, sessionId: world.asking.sessionId }))
      .toMatchObject({ status: "accepted", sent: true, acceptance: "accepted" });
    await probe.eventually(pending, { within: 30_000, label: "B's question has settled", until: requests => requests.length === 0 });
    const calls = await probe.eventually(() => world.mock.agentRequests({ promptMarker: world.asking.prompt }), {
      within: 45_000, label: "B resumes exactly once with the reviewed answer", until: calls => calls.some(call => call.kind === "final"),
    });
    expect(calls.filter(call => call.kind === "final")).toHaveLength(1);
    const messages = await native(`/session/${world.asking.sessionId}/${v2 ? "context" : "message?limit=50"}`);
    expect(JSON.stringify(messages)).toContain(world.asking.answer);
    expect(await permissions()).toEqual(permissionBefore);
    expect((await world.mock.agentRequests({ promptMarker: world.permission.prompt })).filter(call => call.kind === "final")).toEqual([]);
    expect(await probe.hash()).toBe(beforeHash);
    await user.screenshot();
    await user.click("Close review");
    expect(await agent.run("session.question.reply.status", { reviewId: receipt.reviewId, workspaceId, sessionId: world.asking.sessionId }))
      .toMatchObject({ status: "accepted", sent: true });
    expect(items((await attention(world.asking.sessionId)).questions)).toEqual([]);
    expect(items((await attention(world.permission.sessionId)).permissions)).toHaveLength(1);
    await user.reload();
    await user.see("composer", { editable: true, timeoutMs: 45_000 });
    expect(await agent.run("session.question.reply.status", { reviewId: receipt.reviewId, workspaceId, sessionId: world.asking.sessionId }))
      .toMatchObject({ status: "accepted", sent: true, durability: "session" });
    expect((await world.mock.agentRequests({ promptMarker: world.asking.prompt })).filter(call => call.kind === "final")).toHaveLength(1);
    expect(await permissions()).toEqual(permissionBefore);
  });
});
