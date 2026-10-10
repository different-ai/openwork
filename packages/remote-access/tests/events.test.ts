import { test, expect } from "vitest";
const api = (await import("../src/events/replay-buffer.js").catch(
  () => ({}),
)) as any;
const parse = (await import("../src/events/sse.js").catch(() => ({}))) as any;
test("SSE handles split UTF-8, CRLF and multiline data without losing frames", () => {
  expect(parse.SSEParser).toBeTypeOf("function");
  const p = new parse.SSEParser(1000),
    bytes = new TextEncoder().encode(
      'event: change\r\ndata: {"text":"😀"}\r\ndata: more\r\n\r\n: heartbeat\n\n',
    );
  const result: any[] = [];
  for (const b of bytes) result.push(...p.push(new Uint8Array([b])));
  expect(result).toEqual([
    { event: "change", id: null, data: '{"text":"😀"}\nmore' },
  ]);
  expect(() =>
    new parse.SSEParser(4).push(new TextEncoder().encode("data: too long")),
  ).toThrow("EVENT_TOO_LARGE");
});
test("bounded replay filters workspace scope and rejects unavailable cursors", () => {
  expect(api.ReplayBuffer).toBeTypeOf("function");
  const b = new api.ReplayBuffer(2, 1000, "epoch");
  b.append({
    kind: "messageChanged",
    workspaceId: "ws_one",
    sessionId: "ses_one",
  });
  const id = b.append({
    kind: "messageChanged",
    workspaceId: "ws_two",
    sessionId: "ses_two",
  }).id;
  b.append({
    kind: "statusChanged",
    workspaceId: "ws_one",
    sessionId: "ses_one",
  });
  expect(b.replay("epoch:1", ["ws_one"]).events.map((e: any) => e.id)).toEqual([
    "epoch:3",
  ]);
  expect(b.replay("different:2", ["ws_one"]).reset).toBe(true);
  expect(b.replay("epoch:0", ["ws_one"]).reset).toBe(true);
  expect(b.replay(id, ["ws_two"]).events).toEqual([]);
  expect(JSON.stringify(b.replay("epoch:1", ["ws_one"]))).not.toContain(
    "ws_two",
  );
});
