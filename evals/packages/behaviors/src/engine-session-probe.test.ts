import { afterEach, expect, test, vi } from "vitest";
import { engineSessionProbe } from "./engine-session-probe.ts";
import type { EngineSessionProbeEngine, EngineSessionProbeMessage } from "./engine-session-probe.ts";

const v2Message = (name: string) => ({ type: "assistant", content: [{ type: "tool", name, state: { status: "completed", content: [{ type: "text", text: name }] } }] });
const v1Message = (tool: string) => ({ parts: [{ type: "tool", tool, state: { status: "completed", output: tool } }] });
const toolNames = (messages: EngineSessionProbeMessage[] | null | undefined) => messages?.flatMap(message => message.parts.map(part => part.tool));

function probeReturning(engine: EngineSessionProbeEngine, messages: unknown) {
  vi.stubGlobal("fetch", async (url: string) => Response.json(new URL(url).pathname.endsWith("/message") ? messages : { id: "ses_1", title: "Chat" }));
  return engineSessionProbe({ engine, serverUrl: "http://engine.test", token: "token", workspaceId: "ws_1" });
}

afterEach(() => { vi.unstubAllGlobals(); });

test("a native v2 page, which the engine sends newest first, reads oldest first", async () => {
  const probe = probeReturning("v2", { data: [v2Message("third"), v2Message("second"), v2Message("first")], cursor: { next: null } });
  expect(toolNames((await probe.snapshot("ses_1")).data?.messages)).toEqual(["first", "second", "third"]);
  expect(toolNames((await probe.messages("ses_1")).data)).toEqual(["first", "second", "third"]);
});

test("v1 messages already arrive oldest first and keep their order", async () => {
  const probe = probeReturning("v1", [v1Message("first"), v1Message("second"), v1Message("third")]);
  expect(toolNames((await probe.snapshot("ses_1")).data?.messages)).toEqual(["first", "second", "third"]);
  expect(toolNames((await probe.messages("ses_1")).data)).toEqual(["first", "second", "third"]);
});
