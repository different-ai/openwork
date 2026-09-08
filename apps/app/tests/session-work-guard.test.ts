import { expect, test } from "bun:test";
import { createClient } from "../src/app/lib/opencode";
import {
  blockSessionWork, hasPendingSessionSend, isSessionWorkBlocked,
  releaseSessionWork, sessionSendIsCurrent, settleSessionSends, trackSessionSend,
  confirmSessionCommandsStopped, reconcileSessionCommands, sendTrackedSessionCommand,
} from "../src/react-app/domains/session/surface/session-work-guard";

test("archive invalidates old sends across restore without blocking another runtime's same session ID", async () => {
  const owner = "http://one/workspace/owner/opencode";
  const other = "http://two/workspace/other/opencode";
  const sessionId = "same-session";
  const oldSend = sessionSendIsCurrent(owner, sessionId);
  const otherSend = sessionSendIsCurrent(other, sessionId);
  blockSessionWork(owner, sessionId);
  expect(oldSend()).toBe(false);
  expect(otherSend()).toBe(true);
  expect(isSessionWorkBlocked(`${owner}/`, sessionId)).toBe(true);
  expect(isSessionWorkBlocked(owner, "neighbor")).toBe(false);
  let called = false;
  await expect(trackSessionSend(owner, sessionId, async () => { called = true; })).rejects.toThrow("being archived");
  expect(called).toBe(false);
  releaseSessionWork(owner, sessionId);
  expect(oldSend()).toBe(false);
  expect(sessionSendIsCurrent(owner, sessionId)()).toBe(true);
  expect(otherSend()).toBe(true);
});

test("proxy accepted commands retain their identity until engine acknowledgment, not HTTP settlement or idle", async () => {
  const admitted: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body: unknown = await request.json();
      if (typeof body !== "object" || body === null || !("messageID" in body) || typeof body.messageID !== "string") {
        return Response.json({ error: "missing admission ID" }, { status: 400 });
      }
      admitted.push(body.messageID);
      return Response.json({ ok: true, accepted: true });
    },
  });
  const base = `${server.url}workspace/owner/opencode`;
  try {
    const client = createClient(base, undefined, { mode: "openwork" });
    await trackSessionSend(base, "parent", () => sendTrackedSessionCommand(base, client, {
      sessionID: "parent", command: "held", arguments: "",
    }));
    expect(hasPendingSessionSend(base, "parent")).toBe(false);
    blockSessionWork(base, "parent");
    await settleSessionSends(base, "parent");
    expect(reconcileSessionCommands(base, "parent", [])).toEqual({ pending: true, unobserved: true });
    expect(reconcileSessionCommands(`${server.url}workspace/other/opencode`, "parent", [])).toEqual({ pending: false, unobserved: false });
    const messageId = admitted[0];
    expect(messageId).toStartWith("msg_");
    if (!messageId) throw new Error("Command was not admitted");
    expect(reconcileSessionCommands(base, "parent", [{ info: {
      id: "unrelated", role: "assistant", parentID: "another-command", time: { created: 1, completed: 2 },
    } }])).toEqual({ pending: true, unobserved: true });
    expect(reconcileSessionCommands(base, "parent", [{ info: {
      id: messageId, role: "user", time: { created: 1 },
    } }])).toEqual({ pending: true, unobserved: false });
    releaseSessionWork(base, "parent");
    expect(reconcileSessionCommands(base, "parent", [])).toEqual({ pending: true, unobserved: true });
    expect(reconcileSessionCommands(base, "parent", [{ info: {
      id: "reply", role: "assistant", parentID: messageId, time: { created: 1, completed: 2 },
    } }])).toEqual({ pending: false, unobserved: false });

    await sendTrackedSessionCommand(base, client, { sessionID: "child", command: "held", arguments: "" });
    confirmSessionCommandsStopped(base, "parent");
    expect(reconcileSessionCommands(base, "child", [])).toEqual({ pending: true, unobserved: true });
    confirmSessionCommandsStopped(base, "child");
    expect(reconcileSessionCommands(base, "child", [])).toEqual({ pending: false, unobserved: false });
    expect(admitted).toHaveLength(2);
  } finally {
    releaseSessionWork(base, "parent");
    server.stop(true);
  }
});

test("stop waits for an already submitted request, including failure, before checking engine idle", async () => {
  const owner = "http://one/workspace/pending/opencode";
  const request = Promise.withResolvers<void>();
  const pending = trackSessionSend(owner, "pending", () => request.promise);
  const result = pending.catch(() => undefined);
  expect(hasPendingSessionSend(owner, "pending")).toBe(true);
  blockSessionWork(owner, "pending");
  let settled = false;
  const stopping = settleSessionSends(owner, "pending").then(() => { settled = true; });
  await Promise.resolve();
  expect(settled).toBe(false);
  request.reject(new Error("late failure"));
  await result;
  await stopping;
  expect(settled).toBe(true);
  expect(hasPendingSessionSend(owner, "pending")).toBe(false);
  expect(isSessionWorkBlocked(owner, "pending")).toBe(true);
  releaseSessionWork(owner, "pending");
});
