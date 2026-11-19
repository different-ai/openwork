import { addInitScript, browserScript, reload } from "@openwork/cdp";
import { type Place, type Seed } from "@openwork/env";
import { v2StreamReconnect } from "./v2-chat-reconnect.ts";

type RecoveryFault = {
  streams: number;
  comments: number;
  formReads: number;
  exactReads: number;
  held: number;
  released: number;
  recentWindow: number;
  maxConcurrent: number;
  connectedAt: number;
  catchUp(): void;
  interrupt(): void;
  hold(): void;
  remove(truncate: boolean): void;
  release(): void;
  silence(): void;
};

declare global { interface Window { __v2Recovery?: RecoveryFault } }

/** Native HTTP/SSE fault responses exercise the real adapter, cache and chat.
 * No renderer state or product imports are used to arrange the race. */
export async function v2ChatRecovery(seed: Seed, context: { place: Place }) {
  const world = await v2StreamReconnect(seed, context, false);
  if (world.engine !== "v2") throw new Error("Chat recovery requires the v2 proof lane");
  const registration = await addInitScript(world.app.client, browserScript((sid, directory) => {
    const originalFetch = window.fetch.bind(window);
    const encoder = new TextEncoder();
    let complete = false;
    let removed = false;
    let holding = false;
    let silent = false;
    let activeReads = 0;
    let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
    const releases: Array<() => void> = [];
    const message = (id: string, text: string, created: number) => ({
      id, sessionID: sid, type: "assistant", time: { created, completed: created + 1 }, content: [{ type: "text", text }],
    });
    const oldTool = (index: number) => ({
      id: `msg_recovery_old_${index}`, sessionID: sid, type: "assistant", time: { created: index + 1, completed: index + 2 },
      content: [{ type: "tool", id: `call_recovery_${index}`, tool: "shell", state: {
        status: complete ? "completed" : "running", input: { command: `printf recovery-command-${index}` },
        content: [{ type: "text", text: `recovery-result-${index}` }],
      } }],
    });
    const stale = message("msg_recovery_stale", "Discard this superseded answer.", 20);
    const history = () => removed ? [] : [
      ...Array.from({ length: 8 }, (_, i) => oldTool(i)), stale,
      ...(complete ? Array.from({ length: 150 }, (_, i) => message(`msg_recovery_recent_${i}`, `Later answer ${i + 1}.`, 100 + i)) : []),
    ];
    const emit = (type: string, properties: Record<string, unknown>) => {
      if (!controller) throw new Error("No connected event stream");
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type, properties: { sessionID: sid, ...properties }, location: { directory } })}\n\n`));
    };
    const state: RecoveryFault = window.__v2Recovery = {
      streams: 0, comments: 0, formReads: 0, exactReads: 0, held: 0, released: 0, recentWindow: 0, maxConcurrent: 0, connectedAt: 0,
      catchUp() { complete = true; },
      interrupt() { controller?.close(); controller = undefined; },
      hold() {
        holding = true;
        emit("session.tool.success", { messageID: stale.id, callID: "missed-declaration" });
      },
      remove(truncate) {
        removed = true;
        emit(truncate ? "session.revert.committed" : "session.inbox.cancelled", truncate ? { to: stale.id } : { inboxID: stale.id });
      },
      release() { holding = false; for (const release of releases.splice(0)) release(); },
      silence() { silent = true; },
    };
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (method !== "GET" || !url.pathname.includes("/opencode2/api/")) return originalFetch(input, init);
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const json = (data: unknown) => Response.json({ data });
      if (url.pathname.endsWith("/event")) {
        state.streams++;
        state.connectedAt = Date.now();
        return new Response(new ReadableStream<Uint8Array>({
          start(c) {
            controller = c;
            const timer = setInterval(() => {
              if (controller !== c) { clearInterval(timer); return; }
              if (silent) return;
              state.comments++;
              c.enqueue(encoder.encode(": keep-alive\n\n"));
            }, 1_000);
            signal?.addEventListener("abort", () => {
              clearInterval(timer);
              if (controller === c) controller = undefined;
              try { c.close(); } catch { /* The stream may already be closed. */ }
            }, { once: true });
          },
        }), { headers: { "content-type": "text/event-stream" } });
      }
      if (url.pathname.endsWith("/session/active")) return json(complete ? {} : { [sid]: { type: "running" } });
      if (!url.pathname.includes(`/session/${encodeURIComponent(sid)}/`)) return originalFetch(input, init);
      if (url.pathname.endsWith("/form")) {
        state.formReads++;
        return json(complete && !removed ? [{ id: "recovered-question", sessionID: sid, metadata: { kind: "question" }, fields: [{
          key: "format", type: "string", title: "Choose the report format", options: [{ label: "Outline", value: "outline" }],
        }] }] : []);
      }
      if (url.pathname.endsWith("/message")) {
        const limit = Number(url.searchParams.get("limit")) || 140;
        const items = history().slice(-limit);
        if (limit === 24) state.recentWindow = items.length;
        return json(items);
      }
      const id = url.pathname.split("/message/")[1];
      if (id) {
        state.exactReads++;
        activeReads++;
        state.maxConcurrent = Math.max(state.maxConcurrent, activeReads);
        const item = id === stale.id ? stale : history().find((entry) => entry.id === id);
        // Deliberately ignore AbortSignal: the application must reject late
        // responses even when the transport cannot cancel its underlying read.
        if (holding && id === stale.id) {
          state.held++;
          await new Promise<void>((resolve) => releases.push(resolve));
          state.released++;
        } else await new Promise<void>((resolve) => setTimeout(resolve, 50));
        activeReads--;
        return json(item);
      }
      return originalFetch(input, init);
    };
  }, [world.session.sessionId, world.workspacePath]));
  await reload(world.app);
  const act = (action: "catchUp" | "interrupt" | "hold" | "release" | "silence") => seed.evalIn(world.app, browserScript((action) => {
    const fault = window.__v2Recovery;
    if (!fault) throw new Error("Recovery fault is not installed");
    fault[action]();
  }, [action]));
  return {
    ...world,
    act,
    remove: (truncate: boolean) => seed.evalIn(world.app, browserScript((truncate) => window.__v2Recovery?.remove(truncate), [truncate])),
    recovery: () => seed.evalIn(world.app, () => {
      const fault = window.__v2Recovery;
      if (!fault) throw new Error("Recovery fault is not installed");
      return { streams: fault.streams, comments: fault.comments, formReads: fault.formReads, exactReads: fault.exactReads,
        held: fault.held, released: fault.released, recentWindow: fault.recentWindow, maxConcurrent: fault.maxConcurrent,
        connectedAt: fault.connectedAt, now: Date.now() };
    }),
    async [Symbol.asyncDispose]() { await registration.dispose(); await world[Symbol.asyncDispose](); },
  };
}
