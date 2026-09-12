import { addInitScript, browserScript } from "@openwork/cdp";
import { resolveEvalEngine, SkipError, type Seed } from "@openwork/env";

export async function mixedHistoryWeb(seed: Seed) {
  if (resolveEvalEngine() !== "v1") throw new SkipError("synthetic native v1 history (OPENWORK_EVAL_ENGINE=v1)");
  const workspacePath = seed.tmpPath("mixed-history-loading");
  const app = await seed.appWeb({ name: "mixed-history-loading", workspacePath });
  const workspace = await seed.workspace(app, workspacePath);
  const [long, short, landing] = await seed.sessions(app, ["Mixed active history", "Short history control", "History landing"]);
  if (!long || !short || !landing) throw new Error("History fixture sessions were not created");
  const first = "MIXED-HISTORY-FIRST-USER";
  const last = "MIXED-HISTORY-LATEST-ANSWER";
  const shortText = "SHORT-HISTORY-ONLY-USER";
  const storageKey = "openwork.eval.mixed-history-observation";
  const releaseKey = "openwork.eval.mixed-history-release";
  const turns = 160;
  const fixture = await addInitScript(app.client, browserScript((workspaceId, longId, shortId, first, last, shortText, turns, storageKey, releaseKey) => {
    if (window.top !== window) return;
    const port = localStorage.getItem("openwork.server.port");
    if (!port) throw new Error("History fixture requires its isolated server");
    const origin = `http://127.0.0.1:${port}`;
    const mounts = ["workspace", "w"].map(mount => `/${mount}/${encodeURIComponent(workspaceId)}/opencode/session`);
    const created = Date.now() - 1_000_000;
    const makeMessages = (sessionID: string, count: number) => Array.from({ length: count }, (_, index) => {
      const userId = `msg_history_${String(index * 2).padStart(6, "0")}`;
      const assistantId = `msg_history_${String(index * 2 + 1).padStart(6, "0")}`;
      const time = created + index * 1000;
      const text = sessionID === shortId ? shortText : index === 0 ? first : `Mixed history user ${index + 1}`;
      const user = {
        info: { id: userId, sessionID, role: "user", time: { created: time }, agent: "build", model: { providerID: "fixture", modelID: "fixture" } },
        parts: [{ id: `prt_${userId}`, sessionID, messageID: userId, type: "text", text }],
      };
      const mixed = sessionID === longId ? Array.from({ length: 4 }, (_, partIndex) => [
        { id: `prt_${assistantId}_reason_${partIndex}`, sessionID, messageID: assistantId, type: "reasoning", text: `Review checkpoint ${index + 1}.${partIndex + 1}`, time: { start: time, end: time + 100 } },
        { id: `prt_${assistantId}_tool_${partIndex}`, sessionID, messageID: assistantId, type: "tool", tool: "read", callID: `call_${index}_${partIndex}`,
          state: { status: "completed", input: { filePath: "fixture.txt" }, output: `Safe fixture result ${index + 1}.${partIndex + 1}`, title: "Read fixture", metadata: {}, time: { start: time + 100, end: time + 200 } } },
      ]).flat() : [];
      const active = sessionID === longId && index === count - 1;
      const assistant = {
        info: { id: assistantId, sessionID, parentID: userId, role: "assistant", agent: "build", mode: "build", providerID: "fixture", modelID: "fixture",
          path: { cwd: "/fixture", root: "/fixture" }, cost: 0, tokens: { input: 1, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
          time: { created: time + 1, ...(active ? {} : { completed: time + 900 }) }, ...(active ? {} : { finish: "stop" }) },
        parts: [...mixed, { id: `prt_${assistantId}_text`, sessionID, messageID: assistantId, type: "text", text: active ? last : `Checkpoint ${index + 1} recorded.` },
          ...(active ? [{ id: `prt_${assistantId}_active`, sessionID, messageID: assistantId, type: "tool", tool: "read", callID: "call_active",
            state: { status: "running", input: { filePath: "pending-fixture.txt" }, title: "Read pending fixture", metadata: {}, time: { start: time + 950 } } }] : [])],
      };
      return [user, assistant];
    }).flat();
    const longMessages = makeMessages(longId, turns);
    const shortMessages = makeMessages(shortId, 1);
    type HistoryRead = { sessionId: string; limit: number | null; startedAt: number; deliveredAt: number | null; messages: number; parts: number; reasoning: number; tools: number };
    const opens: { sessionId: string; at: number; trusted: boolean; statusSeen: boolean; initialRows: number; samples: number }[] = [];
    const reads: HistoryRead[] = [];
    const state = {
      installedAt: performance.now(), documentId: performance.timeOrigin, samples: 0, mutations: 0, opens, reads,
      expired: false,
    };
    localStorage.removeItem(releaseKey);
    const publish = () => localStorage.setItem(storageKey, JSON.stringify(state));
    const sample = (records: MutationRecord[] = []) => {
      state.samples += 1;
      state.mutations += records.length;
      const opening = state.opens.at(-1);
      if (opening) {
        opening.samples += 1;
        const selector = `[data-session-surface-id="${opening.sessionId}"] [data-thread-history-status]`;
        opening.statusSeen ||= Boolean(document.querySelector(selector)) || records.some(record => [...record.addedNodes].some(node => {
          if (!(node instanceof Element)) return false;
          const scoped = record.target instanceof Element && record.target.closest(`[data-session-surface-id="${opening.sessionId}"]`);
          return node.matches(selector) || Boolean(node.querySelector(selector))
            || Boolean(scoped && (node.matches("[data-thread-history-status]") || node.querySelector("[data-thread-history-status]")));
        }));
      }
      publish();
    };
    const observer = new MutationObserver(sample);
    observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-thread-history-status", "data-session-surface-id"] });
    const capture = (event: MouseEvent) => {
      const button = event.composedPath().find((node): node is HTMLElement => node instanceof HTMLElement
        && [longId, shortId].some(id => node.getAttribute("data-testid") === `sidebar-session-${id}`));
      if (!button) return;
      const sessionId = button.getAttribute("data-testid")?.slice("sidebar-session-".length);
      if (!sessionId) return;
      state.opens.push({ sessionId, at: performance.now(), trusted: event.isTrusted, statusSeen: false,
        initialRows: document.querySelectorAll(`[data-session-surface-id="${sessionId}"] [data-message-id]`).length, samples: 0 });
      sample();
    };
    window.addEventListener("click", capture, true);
    const timer = setInterval(sample, 20);
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.origin !== origin || method !== "GET") return originalFetch.call(window, input, init);
      if (mounts.some(mount => url.pathname === `${mount}/status`)) {
        return Response.json({ [longId]: { type: "busy" } });
      }
      const sessionId = [longId, shortId].find(id => mounts.some(mount => url.pathname === `${mount}/${encodeURIComponent(id)}/message`));
      if (!sessionId) return originalFetch.call(window, input, init);
      const all = sessionId === longId ? longMessages : shortMessages;
      const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : null;
      const messages = limit === null ? all : all.slice(-limit);
      const partTypes = messages.flatMap(message => message.parts.map(part => part.type));
      const read: HistoryRead = { sessionId, limit, startedAt: performance.now(), deliveredAt: null, messages: messages.length,
        parts: partTypes.length, reasoning: partTypes.filter(type => type === "reasoning").length, tools: partTypes.filter(type => type === "tool").length };
      state.reads.push(read);
      publish();
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (sessionId === longId && limit === null) {
        const deadline = performance.now() + 30_000;
        while (localStorage.getItem(releaseKey) !== "released") {
          signal?.throwIfAborted();
          if (performance.now() > deadline) { state.expired = true; publish(); throw new Error("Mixed history gate expired"); }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      } else {
        await new Promise(resolve => setTimeout(resolve, limit === null ? 500 : 150));
      }
      signal?.throwIfAborted();
      read.deliveredAt = performance.now();
      publish();
      return Response.json(messages);
    };
    window.addEventListener("pagehide", () => {
      observer.disconnect();
      clearInterval(timer);
      window.removeEventListener("click", capture, true);
      window.fetch = originalFetch;
    }, { once: true });
    publish();
  }, [workspace.workspaceId, long.sessionId, short.sessionId, first, last, shortText, turns, storageKey, releaseKey]));
  return {
    app, workspace, long, short, landing, first, last, shortText, turns, storageKey,
    release: () => seed.evalIn(app, browserScript(key => { localStorage.setItem(key, "released"); }, [releaseKey])),
    async [Symbol.asyncDispose]() { await fixture.dispose(); },
  };
}
