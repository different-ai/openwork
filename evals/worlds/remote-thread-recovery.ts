import type { Seed } from "@openwork/env";
import { denForAppWeb, signedInAppWeb } from "./signed-in-app-web.ts";
import { seededOrganizationId } from "./organization-capabilities.ts";
import { modelRemovalHttpFixture } from "./model-removal-cdp.ts";

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

/** Real headless app and Den authentication; remote HTTP receipts are controlled faults, never renderer state. */
export async function remoteThreadRecovery(seed: Seed) {
  const { den, webPort } = await denForAppWeb(seed);
  const organizationId = await seededOrganizationId(seed, den.admin);
  const enabled = await seed.api(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
    method: "PUT", body: JSON.stringify({ capabilities: { remoteSessionSubagents: true } }),
  });
  if (!enabled.response.ok) throw new Error(`Remote task rollout setup failed: ${enabled.response.status}`);
  const { app, workspace } = await signedInAppWeb(seed, { den, webPort, name: "remote-thread-recovery", engine: "v2", workspacePath: seed.tmpPath("remote-thread-recovery") });
  const session = await seed.session(app, { title: "Remote project" });
  const now = Date.now();
  const title = "Review project notes";
  const messages = Array.from({ length: 34 }, (_, index) => ({ id: `msg_remote_${index}`, role: index % 2 === 0 ? "user" : "assistant", text: index % 2 === 0 ? `Review section ${index / 2 + 1}` : `Section ${(index + 1) / 2} checked. The project notes remain available for review.`, toolCalls: [] }));
  const history = [
    { id: "msg_owner_01", sessionID: session.sessionId, type: "user", time: { created: now - 10_000 }, text: "Review project notes on the other computer." },
    { id: "msg_owner_02", sessionID: session.sessionId, type: "assistant", time: { created: now - 9_000, completed: now - 8_000 }, model: { providerID: "openai", id: "gpt-4o-mini" }, finish: "stop", content: [
      { type: "tool", callID: "call_remote", tool: "openwork-cloud_execute_capability", time: { created: now - 9_000, ran: now - 9_000, completed: now - 8_000 }, state: { status: "completed", input: { name: "remote-session:create", body: { target: "desktop", title, prompt: "Review project notes" } }, content: [{ type: "text", text: JSON.stringify({ commandId: "remote-proof", sessionId: "ses_remote_proof", workspaceId: "ws_remote_proof" }) }] } },
    ] },
  ];
  let version = 1;
  let stopped = false;
  let outage = false;
  let stopMode: "reject" | "pending" | "accepted" = "reject";
  let sendCount = 0;
  let rejectedSendCount = 0;
  let rejectSend = false;
  let readCount = 0;
  let stopCount = 0;
  let statusCount = 0;
  let receiptReadCount = 0;
  let failedReceiptReads = 0;
  let releaseSend: (() => void) | undefined;
  const statusWaiters = new Set<() => void>();
  const changed = () => { version++; for (const wake of statusWaiters) wake(); };
  const fixture = await modelRemovalHttpFixture(app, ["*/opencode2/api/session/*/message*", "*/v1/remote-sessions/*"], async (url, request) => {
    const root = url.pathname.match(/\/opencode2\/api\/session\/([^/]+)\/message(?:\/([^/]+))?$/);
    if (root?.[1] === session.sessionId && request.method === "GET") return { data: root[2] ? history.find((message) => message.id === root[2]) : history };
    if (!url.pathname.includes("/v1/remote-sessions/") || request.method !== "POST") return undefined;
    const body = isRecord(request.body) ? request.body : {};
    if (url.pathname.endsWith("/status")) {
      statusCount++;
      const requested = Array.isArray(body.threads) && isRecord(body.threads[0]) ? body.threads[0].version : undefined;
      if (requested === String(version) && !outage) await new Promise<void>((resolve) => {
        const wake = () => { clearTimeout(timer); statusWaiters.delete(wake); resolve(); };
        const timer = setTimeout(wake, 20_000); statusWaiters.add(wake);
      });
      if (outage) return { error: "fixture_unavailable" };
      return { threads: requested === String(version) ? [{ ref: "remote-proof", changed: false, version: String(version) }] : [{ ref: "remote-proof", changed: true, version: String(version), target: "desktop", state: stopped ? "error" : "running", waitingFor: null, title, computerId: "cmp_fixture", computerLabel: "Project computer", sessionId: "ses_remote_proof", workspaceId: "ws_remote_proof", messageCount: messages.length, preview: null, error: stopped ? { code: "interrupted", message: "The turn was interrupted.", retryable: false } : null, observedAt: Date.now() }], retryAfterMs: 2_000 };
    }
    if (url.pathname.endsWith("/send")) {
      sendCount++;
      await new Promise<void>((resolve) => { releaseSend = resolve; });
      if (rejectSend) { rejectedSendCount++; return { error: "follow_up_refused", message: "The computer refused this follow-up. Review it before trying again.", retryable: true }; }
      messages.push({ id: String(body.messageId), role: "user", text: String(body.prompt), toolCalls: [] });
      changed(); return { state: "accepted", messageId: body.messageId };
    }
    if (url.pathname.endsWith("/stop")) {
      stopCount++;
      return stopMode === "reject" ? { error: "computer_offline", message: "The computer refused Stop. Try again when it reconnects.", retryable: true } : { state: "pending", requestId: "request_stop_proof" };
    }
    if (url.pathname.endsWith("/read")) {
      if (body.requestId) {
        if (body.requestId !== "request_stop_proof") throw new Error("Recovery read a different remote receipt");
        receiptReadCount++;
        if (stopMode === "pending" && failedReceiptReads === 0) {
          failedReceiptReads++;
          return Response.json({ error: "fixture_connection_lost", message: "The receipt read could not reach the computer." }, { status: 503 });
        }
        return stopMode === "accepted" ? { stopped: true } : { state: "pending", requestId: "request_stop_proof" };
      }
      readCount++;
      return { title, messages: messages.slice(-Number(body.limit ?? 30)), nextCursor: null };
    }
    return undefined;
  }, ["GET", "POST"]);
  return {
    app, session, title,
    releaseFollowUp(rejected = false) { rejectSend = rejected; releaseSend?.(); },
    pendingStop() { stopMode = "pending"; },
    acceptStop() { stopMode = "accepted"; },
    settle() { stopped = true; changed(); },
    disconnect() { outage = true; changed(); },
    reconnect() { outage = false; changed(); },
    counts() { fixture.check(); return { sends: sendCount, rejectedSends: rejectedSendCount, reads: readCount, stops: stopCount, statuses: statusCount, receiptReads: receiptReadCount, failedReceiptReads }; },
    async [Symbol.asyncDispose]() { releaseSend?.(); for (const wake of statusWaiters) wake(); await fixture[Symbol.asyncDispose](); },
  };
}
