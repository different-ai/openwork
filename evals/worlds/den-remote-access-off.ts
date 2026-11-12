import type { Seed } from "@openwork/env";
import type { DenSession } from "@openwork/behaviors";
import { denFetch, freshSession } from "@openwork/behaviors";
import { z } from "zod";
import { remoteDeviceListResponseSchema } from "@openwork/types/den/remote-devices";
import { organizationRemoteSessionSettingsResponseSchema } from "@openwork/types/den/remote-sessions";
import { enableOrganizationCapabilities } from "./organization-capabilities.ts";

/**
 * Remote access that a computer's owner has to allow, in regular Den. Den, its
 * web app, the organization setting, the device registry, the task routes and
 * the runner protocol are real. The computers are stand-ins that speak Den's
 * runner protocol the way OpenWork Desktop does: each keeps its owner's
 * choice, reports it, refuses work itself while it is off, and delivers a
 * task otherwise. One of them registers like an app released before the
 * choice existed. The desktop's own enforcement and settings are covered by
 * packages/remote-sessions and apps/desktop tests.
 */

const WORKSPACE = "fieldnotes";
const CURRENT = ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_answer_v1", "remote_session_access_v1", "remote_session_choice_v1"];
const RELEASED = ["remote_session_v1", "remote_session_control_v1", "remote_session_recovery_v1", "remote_session_answer_v1", "remote_session_access_v1"];

const contextSchema = z.object({ organization: z.object({ id: z.string() }), currentMember: z.object({ id: z.string(), role: z.string() }) });
const workSchema = z.object({
  items: z.array(z.object({ kind: z.string().optional(), commandId: z.string().optional() }).passthrough()),
  sessionAccess: z.object({ ceiling: z.enum(["off", "created", "all"]), optIn: z.boolean().optional() }).optional(),
});
const requestAssignmentSchema = z.object({ assignment: z.object({ requestId: z.string(), action: z.string(), sessionId: z.string(), input: z.record(z.string(), z.unknown()) }) });
const pendingSchema = z.object({ items: z.array(z.object({ requestId: z.string() })) });
const toolResultSchema = z.object({ result: z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional(),
}) });

type Choice = "off" | "created" | null;
type Computer = { label: string; token: string; choice: Choice; released: boolean; delivered: string[]; followUps: string[]; ceiling: string | null };

export async function denRemoteAccessOffWorld(seed: Seed) {
  const stack = new AsyncDisposableStack();
  try {
    const den = await seed.den({ web: true, org: {
      name: "Fieldnotes Studio", admin: { name: "Fixture Platform Operator" },
      members: { owner: { name: "Casey Rivera" }, manager: { name: "Alex Morgan" }, member: { name: "Riley Chen" } },
    } });
    if (!den.database) throw new Error("The remote access proof requires a disposable local database, never an attached Den");
    const organizationId = await enableOrganizationCapabilities(seed, den.admin, { remoteDevices: true, remoteTasksOptIn: true });
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

    const runnerCall = async (computer: Computer, path: string, body?: unknown, method = body === undefined ? "GET" : "POST") => {
      const result = await denFetch(memberSession, path, { method, headers: { authorization: `Bearer ${computer.token}` }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!result.response.ok) throw new Error(`${computer.label} ${method} ${path}: HTTP ${result.response.status} ${result.text.slice(0, 300)}`);
      return result.body;
    };
    /** What applies on the stand-in: its owner's choice, or nothing until they choose (this organization's opt-in), capped by the organization. */
    const effective = (computer: Computer) => computer.released ? "created" : computer.ceiling === "off" ? "off" : computer.choice ?? "off";
    const report = async (computer: Computer) => {
      // An app from before the choice existed reports `created` on its own and says nothing about a choice.
      await runnerCall(computer, "/v1/session-runners/sessions", computer.released
        ? { access: "created", sessions: [] }
        : { access: effective(computer), chosen: computer.choice !== null, sessions: [] }, "PUT");
    };
    const connect = async (installId: string, label: string, choice: Choice, released = false): Promise<Computer> => {
      const minted = z.object({ token: z.string() }).parse(await send(memberSession, "/v1/session-runners/token", {
        runnerId: installId, protocolVersion: 1, supportedExecutionTargets: ["desktop"], appVersion: released ? "1.6.0" : "1.7.0", platform: "darwin", concurrency: 1,
        capabilities: released ? RELEASED : CURRENT,
      }));
      const computer: Computer = { label, token: minted.token, choice, released, delivered: [], followUps: [], ceiling: null };
      // The app also reports the computer itself, which is what the Computers pages list.
      await send(memberSession, "/v1/remote-devices/this-computer", { installId, label, platform: "darwin", appVersion: released ? "1.6.0" : "1.7.0", osVersion: "25.1.0", arch: "arm64" }, "PUT");
      await runnerCall(computer, "/v1/session-runners/inventory", {
        computer: { label, platform: "darwin", appVersion: released ? "1.6.0" : "1.7.0" },
        workspaces: [{ workspaceId: WORKSPACE, name: "Fieldnotes", active: true, engine: "v2", defaultModel: null, models: [] }],
      }, "PUT");
      await report(computer);
      return computer;
    };
    const macbook = await connect("access-off-riley-macbook", "Riley's MacBook Pro", null);
    const mini = await connect("access-off-riley-macmini", "Riley's Mac mini", "created");
    const imac = await connect("access-off-riley-imac", "Riley's old iMac", null, true);
    const computers = [macbook, mini, imac];

    let clock = Date.now();
    const tick = async (computer: Computer) => {
      const work = workSchema.parse(await runnerCall(computer, "/v1/session-runners/work"));
      const ceiling = work.sessionAccess?.ceiling ?? null;
      if (ceiling !== computer.ceiling) {
        computer.ceiling = ceiling;
        await report(computer);
      }
      for (const item of work.items) {
        if (item.kind !== "remote_session_create" || !item.commandId) continue;
        await runnerCall(computer, `/v1/remote-session-commands/${item.commandId}/claim`, {});
        if (effective(computer) === "off") {
          await runnerCall(computer, `/v1/remote-session-commands/${item.commandId}/complete`, { status: "failed", error: { code: "remote_access_off", message: "This computer doesn't take tasks from other devices." } });
          continue;
        }
        const sessionId = `ses_${item.commandId.slice(-12)}`;
        await runnerCall(computer, `/v1/remote-session-commands/${item.commandId}/complete`, { status: "delivered", sessionId, workspaceId: WORKSPACE });
        await runnerCall(computer, `/v1/remote-session-commands/${item.commandId}/session`, { engine: "v2", status: "running", messageCount: 1, latestStep: "Read the notes", observedAt: ++clock });
        computer.delivered.push(sessionId);
      }
      const listed = pendingSchema.parse(await runnerCall(computer, "/v1/remote-session-requests/pending"));
      for (const { requestId } of listed.items) {
        const { assignment } = requestAssignmentSchema.parse(await runnerCall(computer, `/v1/remote-session-requests/${requestId}/claim`, {}));
        if (effective(computer) === "off") {
          await runnerCall(computer, `/v1/remote-session-requests/${requestId}/complete`, { status: "failed", error: { code: "remote_access_off", message: "This computer no longer takes anything from other devices." } });
        } else if (assignment.action === "send") {
          computer.followUps.push(String(assignment.input.prompt));
          await runnerCall(computer, `/v1/remote-session-requests/${requestId}/complete`, { status: "done", outcome: { action: "send", result: { messageId: `msg_follow${computer.followUps.length}`, alreadyPresent: false } } });
        } else {
          await runnerCall(computer, `/v1/remote-session-requests/${requestId}/complete`, { status: "failed", error: { code: "unsupported_request", message: "Not part of this world." } });
        }
      }
    };
    let stopped = false;
    stack.defer(() => { stopped = true; });
    const stopAt = Date.now() + 15 * 60_000;
    void (async () => {
      while (!stopped && Date.now() < stopAt) {
        // A dropped poll is retried, as a runner does.
        for (const computer of computers) await tick(computer).catch(() => undefined);
        await new Promise((resolve) => setTimeout(resolve, 300).unref());
      }
    })();

    // Riley's agent, as any MCP client reaches Den.
    const issued = z.object({ token: z.string() }).parse(await send(memberSession, "/v1/mcp/token", { scopes: ["mcp:read", "mcp:write"] }));
    const capability = async (name: string, body: Record<string, unknown>) => {
      const called = await denFetch(memberSession, "/mcp/agent", {
        method: "POST",
        headers: { authorization: `Bearer ${issued.token}`, accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "execute_capability", arguments: { name, body } } }),
      });
      const line = called.text.split("\n").find((entry) => entry.startsWith("data:"));
      const { result } = toolResultSchema.parse(line ? JSON.parse(line.slice(5)) : called.body);
      const text = result.content?.find((part) => part.type === "text")?.text;
      const parsed: unknown = result.structuredContent ?? (text ? JSON.parse(text) : {});
      return z.record(z.string(), z.unknown()).parse(parsed);
    };

    const viewport = { width: 1440, height: 1000, deviceScaleFactor: 1 };
    const owner = await seed.web({ den, signedInAs: ownerSession, startPath: "/dashboard", headless: true, viewport });
    const member = await seed.web({ den, signedInAs: memberSession, startPath: "/dashboard", headless: true, viewport });
    const person = (who: "member" | "manager" | "owner") => who === "member" ? memberSession : who === "manager" ? managerSession : ownerSession;
    return {
      owner, member, organizationId, workspaceId: WORKSPACE,
      computers: { macbook, mini, imac },
      url: (path: string) => new URL(path, den.ref.webUrl).toString(),
      request: (who: "member" | "manager" | "owner", path: string, body?: unknown, method?: string) => request(person(who), path, body, method),
      /** The member's own computers as Den lists them, with what other devices can do on each. */
      async devices() { return remoteDeviceListResponseSchema.parse(await send(memberSession, "/v1/remote-devices")).devices; },
      async settings(who: "member" | "manager" | "owner") { return organizationRemoteSessionSettingsResponseSchema.parse(await send(person(who), "/v1/org/remote-session-settings")); },
      /** What the member's agent sees as places to run a task. */
      async targets() {
        const listed = z.object({ computers: z.array(z.object({ computerId: z.string(), label: z.string(), access: z.string().optional() })) }).parse(await capability("remote-session:targets", {}));
        return listed.computers;
      },
      /** The member's agent starts a task, on a named computer or wherever Den picks. */
      startTask: (title: string, computerId?: string) => capability("remote-session:create", { target: "registered", title, prompt: "Summarize this week's field notes.", workspaceId: WORKSPACE, ...(computerId ? { computerId } : {}) }),
      /** The owner's choice in Settings > Devices on that computer. */
      async choose(computer: Computer, choice: Exclude<Choice, null>) {
        computer.choice = choice;
        await report(computer);
      },
      async setFeature(key: "remoteTasksOptIn", enabled: boolean) {
        await send(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, { capabilities: { [key]: enabled } }, "PUT");
      },
      async [Symbol.asyncDispose]() { await stack.disposeAsync(); },
    };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
export const supportedTargets = ["local/host"];
