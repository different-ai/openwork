import assert from "node:assert/strict";
import { test } from "node:test";
import { withSseHeartbeat } from "../src/sse-heartbeat.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** An engine event stream the test feeds by hand. */
function engineStream() {
  const state: { controller?: ReadableStreamDefaultController<Uint8Array>; cancelled?: unknown } = {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { state.controller = controller; },
    cancel(reason) { state.cancelled = reason ?? true; },
  });
  return {
    stream,
    send: (frame: string) => state.controller?.enqueue(encoder.encode(frame)),
    end: () => state.controller?.close(),
    fail: (error: Error) => state.controller?.error(error),
    cancelled: () => state.cancelled,
  };
}

async function next(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const { done, value } = await reader.read();
  return done ? null : decoder.decode(value);
}

test("a stream with nothing to say still sends bytes, and every frame arrives whole", async () => {
  const engine = engineStream();
  const reader = withSseHeartbeat(engine.stream, 5).getReader();
  assert.equal(await next(reader), ": heartbeat\n\n");
  assert.equal(await next(reader), ": heartbeat\n\n");
  engine.send('data: {"type":"session.idle"}\n\n');
  const received: string[] = [];
  while (!received.includes('data: {"type":"session.idle"}\n\n')) received.push(await next(reader) ?? "ended");
  for (const chunk of received) assert.ok(chunk === ": heartbeat\n\n" || chunk === 'data: {"type":"session.idle"}\n\n', chunk);
  await reader.cancel();
});

test("a client that leaves releases the engine stream and stops the heartbeat", async () => {
  const engine = engineStream();
  const reader = withSseHeartbeat(engine.stream, 5).getReader();
  assert.equal(await next(reader), ": heartbeat\n\n");
  await reader.cancel("client left");
  assert.equal(engine.cancelled(), "client left");
  // A heartbeat sent into the closed stream would throw from its timer.
  await new Promise((resolve) => setTimeout(resolve, 25));
});

test("the client stream ends when the engine stream ends", async () => {
  const engine = engineStream();
  const reader = withSseHeartbeat(engine.stream, 1_000).getReader();
  engine.send("data: last\n\n");
  engine.end();
  assert.equal(await next(reader), "data: last\n\n");
  assert.equal(await next(reader), null);
});

test("the client stream fails when the engine stream fails", async () => {
  const engine = engineStream();
  const reader = withSseHeartbeat(engine.stream, 1_000).getReader();
  engine.fail(new Error("engine went away"));
  await assert.rejects(reader.read(), /engine went away/);
});
