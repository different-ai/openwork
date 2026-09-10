import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { sessionAttentionZombie } from "../worlds/chat.ts";

const test = spec.world(sessionAttentionZombie, { timeout: 600_000 });

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a native record");
  return Object.fromEntries(Object.entries(value));
}
function records(value: unknown) {
  if (!Array.isArray(value)) throw new Error("Expected a native list");
  return value.map(record);
}
function receiptFrom(value: unknown): Record<string, unknown> {
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
  throw new Error("The proposing agent did not receive a review receipt");
}

test("a stopped and superseded v1 question stays natively listed but is not actionable through attention or a staged review", async ({ world, user, agent, probe, step }) => {
  const workspaceId = world.workspace.workspaceId;
  const ownerId = world.asking.sessionId;
  const mount = `/workspace/${encodeURIComponent(workspaceId)}/opencode`;
  const ownerPath = `/session/${encodeURIComponent(ownerId)}`;
  const read = async (path: string) => {
    const response = await probe.desktopApi(`${mount}${path}`);
    expect(response.status).toBe(200);
    return response.body;
  };
  const pending = async () => records(await read("/question")).filter(question => question.sessionID === ownerId);
  const ownerParts = async () => records(await read(`${ownerPath}/message`)).flatMap(message => records(message.parts));
  const attention = async () => record(await agent.run("session.attention", { workspaceId, sessionId: ownerId }));

  await user.click({ testId: `sidebar-session-${ownerId}` });
  await user.type("composer", world.asking.prompt, { verify: true });
  await user.press("Enter");
  await user.see({ text: world.asking.question }, { timeoutMs: 45_000 });
  const rawBefore = (await pending())[0];
  if (!rawBefore || typeof rawBefore.id !== "string") throw new Error("Expected a pending native question");
  const link = record(rawBefore.tool);
  const requestId = rawBefore.id;
  await user.click({ testId: `sidebar-session-${world.origin.sessionId}` });
  await user.see("composer", { editable: true });
  const focusedHash = await probe.hash();

  const receipt = await step("A stages an answer while B's linked question is still running", async () => {
    const question = records(record((await attention()).questions).items)[0];
    expect(question.requestId).toBe(requestId);
    await world.prepareProposal({ workspaceId, sessionId: ownerId, requestId, fingerprint: question.fingerprint, answers: [[world.asking.answer]] });
    await user.type("composer", world.origin.prompt, { verify: true });
    await user.press("Enter");
    await user.see({ text: "Review question answer" }, { timeoutMs: 45_000 });
    await user.see("Send answer and resume", { timeoutMs: 30_000 });
    await probe.eventually(() => world.mock.agentRequests({ promptMarker: world.origin.prompt }), {
      within: 30_000, label: "the proposal returns without waiting for human confirmation",
      until: calls => calls.some(call => call.kind === "final" && call.completedTools === 1),
    });
    const receipt = receiptFrom(await read(`/session/${world.origin.sessionId}/message`));
    expect(await agent.run("session.question.reply.status", { workspaceId, sessionId: ownerId, reviewId: receipt.reviewId }))
      .toMatchObject({ status: "pending_review", sent: false });
    expect(await probe.hash()).toBe(focusedHash);
    return receipt;
  });

  await step("native abort and follow-up end B's tool but leave its unchanged zombie request listed", async () => {
    expect((await agent.desktopApi(`${mount}${ownerPath}/abort`, { method: "POST" })).status).toBe(200);
    const followup = await agent.desktopApi(`${mount}${ownerPath}/prompt_async`, {
      method: "POST", body: { parts: [{ type: "text", text: world.followup.prompt }] },
    });
    expect([200, 204]).toContain(followup.status);
    await probe.eventually(ownerParts, {
      within: 60_000, label: "the actual superseding task finishes and the old question tool is terminal",
      until: parts => parts.some(part => part.type === "text" && part.text === world.followup.reply)
        && parts.some(part => part.type === "tool" && part.callID === link.callID && ["error", "completed"].includes(String(record(part.state).status))),
    });
    // Require the upstream zombie, not just an empty list that would also pass
    // the old implementation. A changed engine must re-establish this witness.
    expect((await pending()).find(question => question.id === requestId)).toEqual(rawBefore);
    expect(record((await attention()).questions)).toMatchObject({ freshness: "fresh", items: [] });
    expect(await probe.hash()).toBe(focusedHash);
  });

  await step("confirming the staged answer fails closed instead of replying to the zombie", async () => {
    await user.click("Send answer and resume");
    await probe.eventually(() => agent.run("session.question.reply.status", { workspaceId, sessionId: ownerId, reviewId: receipt.reviewId }), {
      within: 30_000, label: "the fresh transcript rejects confirmation before any reply submission",
      until: value => record(value).status === "rejected",
    });
    expect(await agent.run("session.question.reply.status", { workspaceId, sessionId: ownerId, reviewId: receipt.reviewId }))
      .toMatchObject({ status: "rejected", sent: false, acceptance: "not_sent" });
    expect((await pending()).find(question => question.id === requestId)).toEqual(rawBefore);
    expect((await world.mock.agentRequests({ promptMarker: world.followup.prompt })).filter(call => call.kind === "final")).toHaveLength(1);
    expect(await probe.hash()).toBe(focusedHash);
  });
});
