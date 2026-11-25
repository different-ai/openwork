import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { createClientV2, createV2EventTranslationState, translateV2Event } from "../src/app/lib/opencode-v2-adapter";

const ownsDom = typeof window === "undefined";
if (ownsDom) GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });

test("a fresh client restores observed steps only for its own running invocation", async () => {
  const workspace = "http://localhost/w/one/opencode2";
  const sessionID = "ses_reload";
  const messageID = "msg_reload";
  const callID = "call_reload";
  const state = createV2EventTranslationState();
  state.taskSessions.scope = workspace;
  const location = { directory: "/repo" };
  const send = (type: string, extra: Record<string, unknown> = {}) =>
    translateV2Event({ type, location, data: { sessionID, assistantMessageID: messageID, callID, name: "execute", ...extra } }, state);
  const calls = [{ tool: "service.read", status: "running" }];
  send("session.tool.input.started");
  send("session.tool.progress", { metadata: { openworkToolDetails: [{ ...calls[0], input: { query: "private input fixture" } }] } });
  const originalFetch = globalThis.fetch;
  async function read(base: string, status = "running", metadata: Record<string, unknown> = {}) {
    globalThis.fetch = (async () => Response.json({ data: { id: messageID, sessionID, role: "assistant", content: [
      { type: "tool", tool: "execute", callID, state: { status, input: {}, metadata } },
    ] } })) as typeof fetch;
    const result = await createClientV2(base, undefined, {}).session.message({ sessionID, messageID });
    return result.data?.parts.find(part => part.type === "tool")?.state;
  }
  try {
    expect(await read(workspace)).toMatchObject({ metadata: { toolCalls: calls } });
    expect(sessionStorage.getItem("openwork.v2.live-steps.v1")).not.toContain("private input fixture");
    expect(await read("http://localhost/w/two/opencode2")).not.toMatchObject({ metadata: { toolCalls: calls } });
    expect(await read(workspace, "running", { toolCalls: [] })).toMatchObject({ metadata: { toolCalls: [] } });
    expect(await read(workspace)).not.toMatchObject({ metadata: { toolCalls: calls } });
    send("session.tool.progress", { metadata: { toolCalls: calls } });
    expect(await read(workspace)).toMatchObject({ metadata: { toolCalls: calls } });
    await read(workspace, "completed");
    expect(await read(workspace)).not.toMatchObject({ metadata: { toolCalls: calls } });
    send("session.tool.progress", { metadata: { toolCalls: calls } });
    expect(await read(workspace)).toMatchObject({ metadata: { toolCalls: calls } });
    send("session.tool.failed", { error: "cancelled" });
    expect(await read(workspace)).not.toMatchObject({ metadata: { toolCalls: calls } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
