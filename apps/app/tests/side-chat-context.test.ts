import { afterEach, expect, test } from "bun:test";
import type { OpenworkSessionHistory, OpenworkSessionMessage } from "../src/app/lib/openwork-server";
import { buildOpenworkSessionSystemContext } from "../src/react-app/domains/session/sync/env-context";
import { buildSideChatContext } from "../src/react-app/domains/session/sync/side-chat-context";
import { useWorkbenchStore, workbenchSessionKey } from "../src/react-app/domains/session/chat/workbench-store";

const main = { workspaceId: "main-workspace", sessionId: "main-session", title: "Main task" };
const side = { workspaceId: "side-workspace", sessionId: "side-session" };
const initialState = useWorkbenchStore.getState();
afterEach(() => useWorkbenchStore.setState(initialState));
function pair() {
  useWorkbenchStore.setState({ tabs: [main, side], sideChats: { [workbenchSessionKey(main)]: side }, primary: main, secondary: side });
}
function message(id: string, text: string): OpenworkSessionMessage {
  return {
    info: { id, sessionID: main.sessionId, role: "user", time: { created: 1 }, agent: "build", model: { providerID: "test", modelID: "test" } },
    parts: [{ id: `part-${id}`, messageID: id, sessionID: main.sessionId, type: "text", text }],
  };
}
function history(messages = [message("msg-1", "Use Node 24 for the project.")]): OpenworkSessionHistory {
  return { session: { id: main.sessionId, slug: "main", projectID: "project", directory: "/moved-directory", title: main.title, version: "1", time: { created: 1, updated: 2 } }, messages };
}

test("only the linked side chat gets fresh main history, including across workspaces and promotion", async () => {
  pair();
  const reads: unknown[] = [];
  let text = "Use Node 24 for the project.";
  const readSideChatHistory = async (ref: typeof side, options: { limit: number; signal: AbortSignal }) => {
    reads.push(ref);
    expect(options.limit).toBe(40);
    expect(options.signal.aborted).toBe(false);
    return history([message("msg-1", text)]);
  };
  const build = (ref: typeof side) => buildOpenworkSessionSystemContext(null, {
    workspaceId: ref.workspaceId, cacheKey: ref.sessionId, readSideChatHistory,
  });
  expect(await build(main)).not.toContain("Main conversation reference");
  expect(await build({ ...side, sessionId: "unrelated" })).not.toContain("Main conversation reference");
  expect(reads).toEqual([]);
  expect(await build(side)).toContain(text);
  text = "Use Node 26 instead.";
  useWorkbenchStore.setState({ primary: side, secondary: null });
  const refreshed = await build(side);
  expect(refreshed).toContain(text);
  expect(refreshed).not.toContain("Use Node 24");
  expect(reads).toEqual([{ workspaceId: main.workspaceId, sessionId: main.sessionId }, { workspaceId: main.workspaceId, sessionId: main.sessionId }]);
});

test("read failures leave the side chat usable, explicitly missing context, and retry next send", async () => {
  pair();
  const context = await buildSideChatContext(side.workspaceId, side.sessionId, async () => { throw new Error("offline secret URL"); });
  expect(context).toContain("history is unavailable");
  expect(context).toContain("ask the user");
  expect(context).not.toContain("offline secret URL");
  expect(context).not.toContain("Retrieve it through available session tools");
  expect(await buildSideChatContext(side.workspaceId, side.sessionId, async () => history())).toContain("Use Node 24");
});

test("a replaced association during a read cannot inject the old owner's history", async () => {
  pair();
  const pending = Promise.withResolvers<OpenworkSessionHistory>();
  const context = buildSideChatContext(side.workspaceId, side.sessionId, () => pending.promise);
  useWorkbenchStore.setState({ sideChats: {} });
  pending.resolve(history());
  expect(await context).toBeUndefined();
});

test.each(["session", "message", "part"])("rejects mismatched %s ownership", async (kind) => {
  pair();
  const wrong = history();
  if (kind === "session") wrong.session.id = "other";
  if (kind === "message") wrong.messages[0]!.info.sessionID = "other";
  if (kind === "part") wrong.messages[0]!.parts[0]!.messageID = "other";
  const context = await buildSideChatContext(side.workspaceId, side.sessionId, async () => wrong);
  expect(context).toContain("history is unavailable");
  expect(context).not.toContain("Use Node 24");
});

test("context is bounded and omits reasoning, synthetic and ignored text, and tool inputs", async () => {
  pair();
  const item = message("latest", "Visible question");
  const ids = { id: "part", sessionID: main.sessionId, messageID: "latest" };
  item.parts.push(
    { ...ids, type: "text", text: "INTERNAL SYNTHETIC", synthetic: true },
    { ...ids, type: "text", text: "IGNORED TEXT", ignored: true },
    { ...ids, type: "reasoning", text: "PRIVATE REASONING", time: { start: 1 } },
    { ...ids, type: "tool", tool: "read", callID: "call", state: { status: "completed", input: { command: "PRIVATE INPUT" }, output: "Node version file contains 24", title: "Read version", metadata: {}, time: { start: 1, end: 2 } } },
  );
  const data = history([...Array.from({ length: 80 }, (_, i) => message(`msg-${i}`, `older-${i} ` + "x".repeat(8_000))), item]);
  const context = await buildSideChatContext(side.workspaceId, side.sessionId, async () => data);
  expect(context).toContain("Visible question");
  expect(context).toContain("Node version file contains 24");
  expect(context).toContain("truncated");
  expect(context!.length).toBeLessThan(26_000);
  for (const omitted of ["PRIVATE REASONING", "INTERNAL SYNTHETIC", "IGNORED TEXT", "PRIVATE INPUT", "older-0 "]) expect(context).not.toContain(omitted);
});

test("reverted messages are excluded even when their boundary is outside the current page", async () => {
  pair();
  const data = history([message("before", "Kept"), message("reverted", "Discarded")]);
  data.session.revert = { messageID: "reverted" };
  const context = await buildSideChatContext(side.workspaceId, side.sessionId, async () => data);
  expect(context).toContain("Kept");
  expect(context).not.toContain("Discarded");
  data.session.revert.messageID = "before-page";
  expect(await buildSideChatContext(side.workspaceId, side.sessionId, async () => data)).not.toContain("Kept");
});
