import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startConsumer, startProducer } from "./fixtures/checkpoint-stream.mjs";

test("synthetic fixture holds a real HTTP stream and continues without reconnecting", { timeout: 10_000 }, async () => {
  const producer = await startProducer(0);
  let consumer;
  try {
    const address = producer.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    consumer = await startConsumer(address.port, 0);
    const consumerAddress = consumer.server.address();
    assert.ok(consumerAddress && typeof consumerAddress !== "string");
    const consumerOrigin = `http://127.0.0.1:${consumerAddress.port}`;
    const read = () => fetch(`${consumerOrigin}/state`).then((r) => r.json());
    async function until(predicate) {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const state = await read();
        if (predicate(state)) return state;
        await delay(20);
      }
      assert.fail("Fixture did not reach the expected state");
    }
    const held = await until((state) => state.text === "one\ntwo\nthree\n");
    assert.equal(held.completed, false);
    const before = await fetch(`${origin}/state`).then((r) => r.json());
    assert.equal(before.sessions.length, 10);
    assert.equal(before.connections, 1);
    assert.equal((await fetch(`${origin}/continue`, { method: "POST" })).status, 200);
    const after = await until((state) => state.completed);
    assert.equal(after.bootId, held.bootId);
    assert.equal(after.text, "one\ntwo\nthree\nfour\nfive\nsix\n");
    assert.equal(after.failed, false);
    assert.deepEqual(await fetch(`${origin}/state`).then((r) => r.json()), before);
    assert.equal((await fetch(`${origin}/continue`, { method: "POST" })).status, 409);
  } finally {
    if (consumer) await consumer.close();
    producer.closeAllConnections();
    await new Promise((resolve) => producer.close(resolve));
  }
});
