import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { connectionActionPayloadSchema, isMemberConnectionDecision } from "@openwork/types/connection-action-app";
import { serve } from "./serve-node.js";
import { isRecord } from "./workspace-kv-store.js";

export type NativeConnectionRequest = (path: string, init?: {
  method?: string; body?: unknown; directory?: string; timeoutMs?: number;
}) => Promise<{ status: number; json: unknown }>;

const requestSchema = z.object({
  sessionID: z.string().regex(/^ses_[A-Za-z0-9_-]+$/).max(256),
  messageID: z.string().regex(/^msg_[A-Za-z0-9_-]+$/).max(256),
  id: z.string().min(1).max(256),
  tool: z.string().regex(/^(?:openwork|openwork-cloud)_(?:search_capabilities|execute_capability|connection_action)$/),
  connection: connectionActionPayloadSchema.refine(isMemberConnectionDecision),
}).strict();
type DecisionRequest = z.infer<typeof requestSchema>;
type Outcome = "connected" | "skipped" | "unsupported" | "cancelled";

function data(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value.data) ? value.data : null;
}

/**
 * Private, narrowly scoped companion to the read-only context bridge. Its token
 * can create/wait for a connection form, never forward arbitrary native APIs.
 * Native session routes own location resolution, including moved conversations.
 */
export async function createV2ConnectionGateBridge(options: {
  hostRequest: (path: string, init?: RequestInit) => Promise<unknown>;
  nativeRequest: NativeConnectionRequest;
}) {
  const token = randomBytes(32).toString("base64url");
  const lifetime = new AbortController();
  const pending = new Map<string, Promise<Outcome>>();
  const turnPending = new Map<string, Promise<Outcome>>();
  const skipped = new Map<string, { sessionID: string; turnID: string }>();

  async function decide(call: DecisionRequest, caller: AbortSignal): Promise<Outcome> {
    const signal = AbortSignal.any([caller, lifetime.signal, AbortSignal.timeout(30 * 60_000)]);
    const context = await options.hostRequest("/experimental/ui-control/request", {
      method: "POST", body: JSON.stringify({ kind: "context" }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(7_000)]),
    }).catch(() => null);
    // Older UIs know model-issued questions but cannot bind a form to a running
    // MCP call. Never let their ordinary question panel falsely confirm OAuth.
    if (!isRecord(context) || !isRecord(context.context) || !isRecord(context.context.features)
      || context.context.features.connectionDecisions !== true) return "unsupported";
    signal.throwIfAborted();
    const base = `/api/session/${encodeURIComponent(call.sessionID)}`;
    const session = await options.nativeRequest(base, { timeoutMs: 5_000 });
    const info = data(session.json);
    if (session.status !== 200 || !info || (isRecord(info.time) && info.time.archived)) return "cancelled";
    const directory = isRecord(info.location) && typeof info.location.directory === "string" ? info.location.directory : undefined;
    const native: NativeConnectionRequest = (path, init) => options.nativeRequest(path, { directory, timeoutMs: 5_000, ...init });

    async function current(): Promise<boolean> {
      signal.throwIfAborted();
      const [message, active] = await Promise.all([
        native(`${base}/message/${encodeURIComponent(call.messageID)}`),
        native("/api/session/active"),
      ]);
      const owner = data(message.json);
      const running = data(active.json)?.[call.sessionID];
      return message.status === 200 && active.status === 200 && isRecord(running) && running.type === "running"
        && owner?.id === call.messageID && owner.type === "assistant" && Array.isArray(owner.content)
        && owner.content.some(part => isRecord(part) && part.type === "tool" && part.id === call.id
          && (part.name === call.tool || part.name === "execute")
          && isRecord(part.state) && part.state.status === "running");
    }

    let formId: string | undefined;
    let settled = false;
    let finish = (outcome: Outcome): Outcome => outcome;
    try {
      if (!await current()) return "cancelled";
      const contextResponse = await native(`${base}/context`);
      const contextData = isRecord(contextResponse.json) ? contextResponse.json.data : undefined;
      if (contextResponse.status !== 200 || !Array.isArray(contextData)) return "cancelled";
      const messages = contextData.filter(isRecord);
      const sourceIndex = messages.findIndex(message => message.id === call.messageID);
      const turn = messages.slice(0, sourceIndex).reverse().find(message => message.type === "user");
      if (sourceIndex < 0 || typeof turn?.id !== "string") return "cancelled";
      const turnKey = JSON.stringify([call.sessionID, turn.id, call.connection.connectionId]);
      for (const [key, entry] of skipped) {
        if (entry.sessionID === call.sessionID && entry.turnID !== turn.id) skipped.delete(key);
      }
      // Code Mode can catch a failed call and check its status before returning
      // to the model. A prompt cannot stop that already-running program from
      // asking again, so remember Skip for the original user turn.
      if (skipped.has(turnKey)) return "skipped";
      const previous = turnPending.get(turnKey);
      if (previous) {
        // Parallel calls share the card, but every waiter still belongs to its
        // own live source call. Cancelling a waiter must not confirm OAuth.
        while (await current()) {
          const outcome = await Promise.race([previous, delay(200, undefined, { signal })]);
          if (outcome !== undefined) return await current() ? outcome : "cancelled";
        }
        return "cancelled";
      }
      let resolveChoice: (outcome: Outcome) => void = () => undefined;
      const choice = new Promise<Outcome>(resolve => { resolveChoice = resolve; });
      turnPending.set(turnKey, choice);
      finish = outcome => {
        resolveChoice(outcome);
        if (turnPending.get(turnKey) === choice) turnPending.delete(turnKey);
        return outcome;
      };
      const created = await native(`${base}/form`, { method: "POST", body: {
        title: "Connection",
        metadata: { kind: "question", tool: { messageID: call.messageID, id: call.id }, openworkConnectionDecision: { connection: call.connection } },
        fields: [{
          key: "connection", type: "string", title: "Connection", description: `Connect ${call.connection.connectionName} to continue?`,
          required: true, custom: false,
          options: [
            { value: "authenticate", label: "Authenticate", description: "Connect this account to continue." },
            { value: "skip", label: "Skip", description: "Continue without this connection." },
          ],
        }],
      } });
      const form = data(created.json);
      if (created.status !== 200 || typeof form?.id !== "string" || !/^frm_[A-Za-z0-9_-]+$/.test(form.id)) {
        throw new Error("Could not open the connection decision.");
      }
      formId = form.id;
      // HTTP-created forms do not inherit the native question tool's interrupt
      // cleanup. Check the exact originating call, not merely session activity.
      while (await current()) {
        const response = await native(`${base}/form/${encodeURIComponent(formId)}/state`);
        const state = data(response.json);
        if (response.status !== 200 || state?.status === "cancelled") return finish("cancelled");
        if (state?.status === "answered") {
          settled = true;
          if (!await current()) return finish("cancelled");
          const answer = isRecord(state.answer) ? state.answer.connection : undefined;
          if (answer === "skip") {
            if (skipped.size >= 1_000) {
              const oldest = skipped.keys().next().value;
              if (oldest !== undefined) skipped.delete(oldest);
            }
            skipped.set(turnKey, { sessionID: call.sessionID, turnID: turn.id });
            return finish("skipped");
          }
          return finish(answer === "authenticate" ? "connected" : "cancelled");
        }
        if (state?.status !== "pending") return finish("cancelled");
        await delay(200, undefined, { signal });
      }
      return finish("cancelled");
    } finally {
      finish("cancelled");
      if (formId && !settled) {
        // Cleanup must not reuse the aborted waiting request's signal.
        await native(`${base}/form/${encodeURIComponent(formId)}/cancel`, { method: "POST", timeoutMs: 2_000 }).catch(() => undefined);
      }
    }
  }

  const server = await serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.headers.get("authorization") !== `Bearer ${token}`) return new Response(null, { status: 401 });
    if (request.method !== "POST" || new URL(request.url).pathname !== "/decision") return new Response(null, { status: 404 });
    try {
      const text = await request.text();
      if (text.length > 16_384) return new Response(null, { status: 413 });
      const call = requestSchema.parse(JSON.parse(text));
      const key = JSON.stringify([call.sessionID, call.messageID, call.id, call.connection.connectionId]);
      const existing = pending.get(key);
      if (existing) return Response.json({ outcome: await existing });
      if (pending.size >= 200) return new Response(null, { status: 429 });
      const outcome = decide(call, request.signal).catch((): Outcome => "cancelled");
      pending.set(key, outcome);
      try { return Response.json({ outcome: await outcome }); }
      finally { pending.delete(key); }
    } catch {
      return Response.json({ error: "Invalid connection decision request" }, { status: 400 });
    }
  } });
  return {
    url: `http://127.0.0.1:${server.port}/decision`, token,
    async close() { lifetime.abort(); await Promise.allSettled(pending.values()); await server.stop(); },
  };
}
