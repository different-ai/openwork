import { addInitScript, browserScript } from "@openwork/cdp";
import { resolveEvalEngine, SkipError, type Seed } from "@openwork/env";

export async function pagedHistoryStatusWeb(seed: Seed) {
  if (resolveEvalEngine() !== "v1") throw new SkipError("synthetic native v1 history (OPENWORK_EVAL_ENGINE=v1)");
  const workspacePath = seed.tmpPath("paged-history-status");
  const app = await seed.appWeb({ name: "paged-history-status", workspacePath });
  const workspace = await seed.workspace(app, workspacePath);
  const [long, short, landing] = await seed.sessions(app, ["Paged long history", "Paged short history", "Paged history landing"]);
  if (!long || !short || !landing) throw new Error("History fixture sessions were not created");
  const turns = 15;
  const first = "PAGED-HISTORY-FIRST-USER";
  const latestUser = `Paged history user ${turns}`;
  const findText = "Paged history user 6";
  const shortText = "PAGED-SHORT-HISTORY-ONLY";
  const storageKey = "openwork.eval.paged-history-status";
  const releaseKey = "openwork.eval.paged-history-status-release";
  const failKey = "openwork.eval.paged-history-status-fail";
  const fixture = await addInitScript(app.client, browserScript((workspaceId, longId, shortId, first, latestUser, shortText, turns, storageKey, releaseKey, failKey) => {
    if (window.top !== window) return;
    const port = localStorage.getItem("openwork.server.port");
    if (!port) throw new Error("History fixture requires its isolated server");
    const origin = `http://127.0.0.1:${port}`;
    const mounts = ["workspace", "w"].map((mount) => `/${mount}/${encodeURIComponent(workspaceId)}/opencode/session`);
    const created = Date.now() - 1_000_000;
    const makeMessages = (sessionID: string, count: number) => Array.from({ length: count }, (_, index) => {
      const userId = `msg_paged_${String(index * 2).padStart(6, "0")}`;
      const assistantId = `msg_paged_${String(index * 2 + 1).padStart(6, "0")}`;
      const time = created + index * 1000;
      const userText = sessionID === shortId ? shortText : index === 0 ? first : index === count - 1 ? latestUser : `Paged history user ${index + 1}`;
      return [
        {
          info: { id: userId, sessionID, role: "user", time: { created: time }, agent: "build", model: { providerID: "fixture", modelID: "fixture" } },
          parts: [{ id: `prt_${userId}`, sessionID, messageID: userId, type: "text", text: userText }],
        },
        {
          info: { id: assistantId, sessionID, parentID: userId, role: "assistant", agent: "build", mode: "build", providerID: "fixture", modelID: "fixture",
            path: { cwd: "/fixture", root: "/fixture" }, cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: time + 1, completed: time + 900 }, finish: "stop" },
          parts: [{ id: `prt_${assistantId}`, sessionID, messageID: assistantId, type: "text", text: `Paged answer ${index + 1}` }],
        },
      ];
    }).flat();
    const histories = new Map([[longId, makeMessages(longId, turns)], [shortId, makeMessages(shortId, 1)]]);
    type Read = { sessionId: string; limit: number | null; before: string | null; nextCursor: string | null; startedAt: number; deliveredAt: number | null; messages: number };
    const reads: Read[] = [];
    const opens: { sessionId: string; at: number; samples: number; statusSeen: boolean }[] = [];
    const state = { installedAt: performance.now(), samples: 0, reads, opens, expired: false };
    localStorage.removeItem(releaseKey);
    localStorage.removeItem(failKey);
    const publish = () => localStorage.setItem(storageKey, JSON.stringify(state));
    const sample = () => {
      state.samples += 1;
      const opening = opens.at(-1);
      if (opening) {
        opening.samples += 1;
        opening.statusSeen ||= Boolean(document.querySelector(`[data-session-surface-id="${opening.sessionId}"] [data-thread-history-status]`));
      }
      publish();
    };
    const observer = new MutationObserver(sample);
    observer.observe(document, { subtree: true, childList: true, attributes: true });
    const capture = (event: MouseEvent) => {
      const target = event.composedPath().find((node): node is HTMLElement => node instanceof HTMLElement
        && [longId, shortId].some((id) => node.getAttribute("data-testid") === `sidebar-session-${id}`));
      const sessionId = target?.getAttribute("data-testid")?.slice("sidebar-session-".length);
      if (!sessionId) return;
      opens.push({ sessionId, at: performance.now(), samples: 0, statusSeen: false });
      sample();
    };
    window.addEventListener("click", capture, true);
    const timer = setInterval(sample, 20);
    const originalFetch = window.fetch;
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = init?.method ?? (input instanceof Request ? input.method : "GET");
      if (url.origin !== origin || method !== "GET") return originalFetch.call(window, input, init);
      if (mounts.some((mount) => url.pathname === `${mount}/status`)) return Response.json({ [longId]: { type: "busy" } });
      const sessionId = [longId, shortId].find((id) => mounts.some((mount) => url.pathname === `${mount}/${encodeURIComponent(id)}/message`));
      if (!sessionId) return originalFetch.call(window, input, init);
      const all = histories.get(sessionId) ?? [];
      const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : null;
      const before = url.searchParams.get("before");
      const parsed = before?.startsWith("cursor-") ? Number(before.slice("cursor-".length)) : all.length;
      const end = Number.isInteger(parsed) && parsed >= 0 && parsed <= all.length ? parsed : all.length;
      const start = limit === null ? 0 : Math.max(0, end - limit);
      const messages = all.slice(start, end);
      const nextCursor = start > 0 ? `cursor-${start}` : null;
      const read: Read = { sessionId, limit, before, nextCursor, startedAt: performance.now(), deliveredAt: null, messages: messages.length };
      reads.push(read);
      publish();
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      if (sessionId === longId && before !== null) {
        const deadline = performance.now() + 30_000;
        while (localStorage.getItem(releaseKey) !== "released") {
          signal?.throwIfAborted();
          if (localStorage.getItem(failKey) === "next") {
            localStorage.removeItem(failKey);
            throw new Error("Synthetic final page failure");
          }
          if (performance.now() > deadline) { state.expired = true; publish(); throw new Error("Paged history gate expired"); }
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } else await new Promise((resolve) => setTimeout(resolve, limit === null ? 250 : 100));
      signal?.throwIfAborted();
      read.deliveredAt = performance.now();
      publish();
      const headers = nextCursor ? { "X-Next-Cursor": nextCursor } : undefined;
      return Response.json(messages, { headers });
    };
    window.addEventListener("pagehide", () => {
      observer.disconnect();
      clearInterval(timer);
      window.removeEventListener("click", capture, true);
      window.fetch = originalFetch;
    }, { once: true });
    publish();
  }, [workspace.workspaceId, long.sessionId, short.sessionId, first, latestUser, shortText, turns, storageKey, releaseKey, failKey]));
  return {
    app, workspace, long, short, landing, turns, first, latestUser, findText, shortText, storageKey,
    failOlder: () => seed.evalIn(app, browserScript((key) => localStorage.setItem(key, "next"), [failKey])),
    releaseOlder: () => seed.evalIn(app, browserScript((key) => localStorage.setItem(key, "released"), [releaseKey])),
    async [Symbol.asyncDispose]() { await fixture.dispose(); },
  };
}
