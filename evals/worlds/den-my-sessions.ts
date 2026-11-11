import type { Seed } from "@openwork/env";
import type { DenSession } from "@openwork/behaviors";
import { denFetch, freshSession } from "@openwork/behaviors";
import { z } from "zod";
import { memberSessionListResponseSchema, organizationRemoteSessionSettingsResponseSchema } from "@openwork/types/den/remote-sessions";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/**
 * My Sessions in regular Den, with the access policy end to end.
 *
 * Den, its web app, the org setting, the session list, attach, the request
 * queue and the runner protocol are real. One thing is synthetic: Riley's
 * computer, a small loop below that speaks Den's runner protocol the way
 * OpenWork Desktop does. It keeps its owner's choice, learns the
 * organization's ceiling from work polls, reports its sessions only while both
 * allow all of them, refuses an attach otherwise, serves transcript reads with
 * every open permission and question, and records each answer it is given.
 * The desktop's own enforcement and settings control are covered by
 * packages/remote-sessions and apps/desktop tests.
 */

const COMPUTER = "Riley's MacBook Pro";
const WORKSPACE = "fieldnotes";
const LOCAL_SESSION = "ses_budgetreview";
const LOCAL_TITLE = "Q4 budget review";
const REMOTE_SESSION = "ses_releasenotes";
const REMOTE_TITLE = "Draft the release notes";

const contextSchema = z.object({ organization: z.object({ id: z.string() }), currentMember: z.object({ id: z.string(), role: z.string() }) });
const workSchema = z.object({
  items: z.array(z.object({ kind: z.string().optional(), commandId: z.string().optional() }).passthrough()),
  sessionAccess: z.object({ ceiling: z.enum(["created", "all"]) }).optional(),
});
const attachAssignmentSchema = z.object({ assignment: z.object({
  commandId: z.string(), kind: z.literal("remote_session_attach"), prompt: z.null(), model: z.null(), workspaceId: z.string(), sessionId: z.string(),
}) });
const requestAssignmentSchema = z.object({ assignment: z.object({
  requestId: z.string(), commandId: z.string(), sessionId: z.string(), action: z.enum(["read", "send", "stop", "answer"]), input: z.record(z.string(), z.unknown()),
}) });
const pendingListSchema = z.object({ items: z.array(z.object({ requestId: z.string() })) });

type Access = "created" | "all";
type Answer =
  | { kind: "permission"; requestId: string; decision: string }
  | { kind: "question"; requestId: string; answers: string[][] }
  | { kind: "dismiss"; requestId: string };

const permission = {
  kind: "permission" as const, requestId: "per_export", title: "Run a command", detail: "Export the budget table to a spreadsheet",
  command: "python export.py --quarter Q4 --out budget-q4.xlsx",
};
const scope = {
  kind: "question" as const, requestId: "form_scope", questions: [
    { header: "Period", question: "Which period should the review cover?", multiple: false, custom: false,
      options: [{ label: "This quarter", description: "October to December" }, { label: "Full year", description: "January to December" }] },
    { header: "Teams", question: "Which teams should be included?", multiple: true, custom: true,
      options: [{ label: "Design", description: "" }, { label: "Engineering", description: "" }] },
  ],
};
const email = {
  kind: "question" as const, requestId: "form_email", questions: [
    { header: "Share", question: "Email the summary to finance when it is done?", multiple: false, custom: false,
      options: [{ label: "Yes, email it", description: "" }, { label: "No", description: "" }] },
  ],
};

export async function denMySessionsWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const den = await seed.den({ web: true, org: {
      name: "Fieldnotes Studio", admin: { name: "Fixture Platform Operator" },
      members: { owner: { name: "Casey Rivera" }, manager: { name: "Alex Morgan" }, member: { name: "Riley Chen" } },
    } });
    if (!den.database) throw new Error("My Sessions proof requires a disposable local database, never an attached Den");
    const organizationId = await enableOrganizationCapabilities(seed, den.admin, { remoteDevices: true, remoteSessionAccess: true });
    const request = (session: DenSession, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
      denFetch(session, path, { method, headers: { authorization: `Bearer ${session.token}`, "x-openwork-org-id": organizationId }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const send = async (session: DenSession, path: string, body?: unknown, method?: string) => {
      const result = await request(session, path, body, method);
      if (!result.response.ok) throw new Error(`${method ?? (body === undefined ? "GET" : "POST")} ${path}: HTTP ${result.response.status} ${result.text.slice(0, 400)}`);
      return result.body;
    };
    // The seeded operator hands the organization to an ordinary owner; the manager becomes an ordinary admin.
    const fixtureId = contextSchema.parse(await send(den.admin, "/v1/org")).currentMember.id;
    const ownerId = contextSchema.parse(await send(den.members.owner, "/v1/org")).currentMember.id;
    const managerId = contextSchema.parse(await send(den.members.manager, "/v1/org")).currentMember.id;
    await send(den.admin, `/v1/members/${managerId}/role`, { role: "admin" });
    await send(den.admin, `/v1/members/${ownerId}/role`, { role: "admin" });
    await send(den.admin, `/v1/members/${ownerId}/transfer-ownership`, undefined, "POST");
    den.members.owner = await freshSession(den.members.owner);
    den.members.manager = await freshSession(den.members.manager);
    den.admin = await freshSession(den.admin);
    stack.defer(async () => {
      const owner = await freshSession(den.members.owner);
      await send(owner, `/v1/members/${fixtureId}/role`, { role: "admin" });
      await send(owner, `/v1/members/${fixtureId}/transfer-ownership`, undefined, "POST");
      den.admin = await freshSession(den.admin);
    });
    const ownerSession = den.members.owner, managerSession = den.members.manager, memberSession = den.members.member;

    // Riley's computer signs in as Riley's runner, with everything a current desktop registers.
    const minted = z.object({ token: z.string() }).parse(await send(memberSession, "/v1/session-runners/token", {
      runnerId: "den-my-sessions-riley-mac", protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: "1.6.0", platform: "darwin", concurrency: 1,
      capabilities: ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_answer_v1", "remote_session_access_v1"],
    }));
    const runner: DenSession = { ...memberSession, token: minted.token };
    const runnerCall = async (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
      const result = await denFetch(runner, path, { method, headers: { authorization: `Bearer ${minted.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!result.response.ok) throw new Error(`Runner ${method} ${path}: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
      return result.body;
    };
    await runnerCall("/v1/session-runners/inventory", {
      computer: { label: COMPUTER, platform: "darwin", appVersion: "1.6.0" },
      workspaces: [{ workspaceId: WORKSPACE, name: "Fieldnotes", active: true, engine: "v2", defaultModel: null, models: [] }],
    }, "PUT");

    // A task Riley's agent started on that computer from elsewhere: reachable under either policy.
    const issued = z.object({ token: z.string() }).parse(await send(memberSession, "/v1/mcp/token", { scopes: ["mcp:read", "mcp:write"] }));
    const created = await denFetch(memberSession, "/mcp/agent", {
      method: "POST",
      headers: { authorization: `Bearer ${issued.token}`, accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_capability", arguments: {
        name: "remote-session:create", body: { target: "registered", title: REMOTE_TITLE, prompt: "Draft the release notes from the merged pull requests.", workspaceId: WORKSPACE },
      } } }),
    });
    const line = created.text.split("\n").find((entry) => entry.startsWith("data:"));
    const envelope: unknown = line ? JSON.parse(line.slice(5)) : created.body;
    const remoteCommandId = z.object({ result: z.object({ structuredContent: z.object({ commandId: z.string() }) }) }).parse(envelope).result.structuredContent.commandId;
    await runnerCall(`/v1/remote-session-commands/${remoteCommandId}/claim`, {});
    await runnerCall(`/v1/remote-session-commands/${remoteCommandId}/complete`, { status: "delivered", sessionId: REMOTE_SESSION, workspaceId: WORKSPACE });
    let clock = Date.now();
    const progress = (commandId: string, body: Record<string, unknown>) => runnerCall(`/v1/remote-session-commands/${commandId}/session`, { engine: "v2", ...body, observedAt: ++clock });
    await progress(remoteCommandId, { status: "running", messageCount: 2, latestStep: "Read CHANGELOG.md" });

    // The computer's own state.
    let choice: Access = "created";
    let ceiling: Access = "created";
    let reported: string | null = null;
    let attachedCommandId: string | null = null;
    let open: Array<typeof permission | typeof scope | typeof email> = [permission, scope, email];
    const answers: Answer[] = [];
    const followUps: string[] = [];
    const refusedAttaches: string[] = [];
    const effective = (): Access => choice === "all" && ceiling === "all" ? "all" : "created";
    const started = Date.now() - 3 * 60_000;
    const messages = () => [
      { id: "msg_ask", role: "user", createdAt: started, text: "Review the Q4 budget and flag anything over plan.", truncated: false, toolCalls: [], error: null },
      { id: "msg_work", role: "assistant", createdAt: started + 60_000, text: "Travel is 18% over plan. See https://example.com/budget for the table. I need a few answers before I export it.", truncated: false, toolCalls: [], error: null },
      ...followUps.map((text, index) => ({ id: `msg_follow${index}`, role: "user", createdAt: started + 120_000 + index, text, truncated: false, toolCalls: [], error: null })),
    ];
    const transcript = () => ({
      title: LOCAL_TITLE, status: open.length ? "waiting" : "idle", waitingFor: open[0]?.kind ?? null, lastError: null, historyScope: "full",
      messageCount: messages().length, from: "end", nextCursor: null, pending: open[0] ?? null, pendingItems: open, messages: messages(),
    });
    const reportLocal = async () => {
      if (!attachedCommandId) return;
      await progress(attachedCommandId, open.length
        ? { status: "waiting", waitingFor: open[0].kind, pending: open[0], messageCount: messages().length }
        : { status: "idle", waitingFor: null, pending: null, messageCount: messages().length, finalText: "Budget exported." });
    };
    const fail = (requestId: string, code: string, message: string) =>
      runnerCall(`/v1/remote-session-requests/${requestId}/complete`, { status: "failed", error: { code, message } });
    const tick = async () => {
      const work = workSchema.parse(await runnerCall("/v1/session-runners/work"));
      ceiling = work.sessionAccess?.ceiling ?? "created";
      const access = effective();
      const report = JSON.stringify([access, work.sessionAccess !== undefined]);
      if (work.sessionAccess && report !== reported) {
        await runnerCall("/v1/session-runners/sessions", {
          access,
          sessions: access === "all" ? [
            { workspaceId: WORKSPACE, sessionId: LOCAL_SESSION, title: LOCAL_TITLE, engine: "v2", updatedAt: Date.now(), working: false },
            { workspaceId: WORKSPACE, sessionId: REMOTE_SESSION, title: REMOTE_TITLE, engine: "v2", updatedAt: Date.now() - 60_000, working: true },
          ] : [],
        }, "PUT");
        reported = report;
      }
      for (const item of work.items) {
        if (item.kind !== "remote_session_attach" || !item.commandId) continue;
        const { assignment } = attachAssignmentSchema.parse(await runnerCall(`/v1/remote-session-commands/${item.commandId}/claim`, {}));
        if (effective() !== "all") {
          refusedAttaches.push(assignment.sessionId);
          await runnerCall(`/v1/remote-session-commands/${assignment.commandId}/complete`, { status: "failed", error: { code: "session_access_denied", message: "This computer only allows sessions that were started remotely." } });
        } else if (assignment.sessionId !== LOCAL_SESSION || assignment.workspaceId !== WORKSPACE) {
          await runnerCall(`/v1/remote-session-commands/${assignment.commandId}/complete`, { status: "failed", error: { code: "session_unavailable", message: "That session is not in this workspace on this computer." } });
        } else {
          await runnerCall(`/v1/remote-session-commands/${assignment.commandId}/complete`, { status: "delivered", sessionId: LOCAL_SESSION, workspaceId: WORKSPACE });
          attachedCommandId = assignment.commandId;
          await reportLocal();
        }
      }
      const listed = pendingListSchema.parse(await runnerCall("/v1/remote-session-requests/pending"));
      for (const { requestId } of listed.items) {
        const { assignment } = requestAssignmentSchema.parse(await runnerCall(`/v1/remote-session-requests/${requestId}/claim`, {}));
        const done = (result: unknown) => runnerCall(`/v1/remote-session-requests/${requestId}/complete`, { status: "done", outcome: { action: assignment.action, result } });
        if (assignment.sessionId !== LOCAL_SESSION) {
          await fail(requestId, "unsupported_request", "Not part of this world.");
        } else if (effective() !== "all") {
          await fail(requestId, "session_access_denied", "This computer no longer allows sessions that were started on it.");
        } else if (assignment.action === "read") {
          await done(transcript());
        } else if (assignment.action === "send") {
          followUps.push(String(assignment.input.prompt));
          await done({ messageId: `msg_follow${followUps.length - 1}`, alreadyPresent: false });
          await reportLocal();
        } else if (assignment.action === "stop") {
          await done({ stopped: false, reason: null });
        } else {
          const answer = z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("permission"), requestId: z.string(), decision: z.string() }),
            z.object({ kind: z.literal("question"), requestId: z.string(), answers: z.array(z.array(z.string())) }),
            z.object({ kind: z.literal("dismiss"), requestId: z.string() }),
          ]).parse(assignment.input);
          const target = open.find((item) => item.requestId === answer.requestId);
          if (!target || (answer.kind === "permission") !== (target.kind === "permission")) {
            await fail(requestId, "stale_request", "That request is no longer pending. Read the session again.");
          } else {
            answers.push(answer);
            open = open.filter((item) => item !== target);
            await done({ requestId: answer.requestId, alreadyAnswered: false });
            await reportLocal();
          }
        }
      }
    };
    let stopped = false;
    stack.defer(() => { stopped = true; });
    const stopAt = Date.now() + 15 * 60_000;
    void (async () => {
      while (!stopped && Date.now() < stopAt) {
        // A dropped poll is retried, as a runner does.
        await tick().catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 300).unref());
      }
    })();

    const viewport = { width: 1440, height: 1000, deviceScaleFactor: 1 };
    const owner = await seed.web({ den, signedInAs: ownerSession, startPath: "/dashboard", headless: true, viewport });
    const member = await seed.web({ den, signedInAs: memberSession, startPath: "/dashboard", headless: true, viewport });
    return {
      owner, member, organizationId, computer: COMPUTER, workspaceId: WORKSPACE,
      local: { sessionId: LOCAL_SESSION, title: LOCAL_TITLE }, remote: { sessionId: REMOTE_SESSION, title: REMOTE_TITLE, commandId: remoteCommandId },
      permission, scope, email,
      url: (path: string) => new URL(path, den.ref.webUrl).toString(),
      ownerRequest: (path: string, body?: unknown, method?: string) => request(ownerSession, path, body, method),
      managerRequest: (path: string, body?: unknown, method?: string) => request(managerSession, path, body, method),
      memberRequest: (path: string, body?: unknown, method?: string) => request(memberSession, path, body, method),
      async roles() {
        const role = async (session: DenSession) => contextSchema.parse(await send(session, "/v1/org")).currentMember.role;
        return { owner: await role(ownerSession), manager: await role(managerSession), member: await role(memberSession) };
      },
      async sessions(session: "member" | "manager" | "owner" = "member") {
        return memberSessionListResponseSchema.parse(await send(session === "member" ? memberSession : session === "manager" ? managerSession : ownerSession, "/v1/sessions"));
      },
      async settings(session: "member" | "manager" | "owner") {
        return organizationRemoteSessionSettingsResponseSchema.parse(await send(session === "member" ? memberSession : session === "manager" ? managerSession : ownerSession, "/v1/org/remote-session-settings"));
      },
      /** Riley's choice in Settings > Devices on the computer itself. */
      setComputerChoice(mode: Access) { choice = mode; },
      /** What the computer was given by its owner from Den. */
      answers: () => [...answers],
      followUps: () => [...followUps],
      refusedAttaches: () => [...refusedAttaches],
      attachedCommandId: () => attachedCommandId,
      async setEnabled(enabled: boolean) { await send(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, { capabilities: { remoteSessionAccess: enabled } }, "PUT"); },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
export const supportedTargets = ["local/host"];
