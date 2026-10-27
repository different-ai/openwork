import { createServer, type Socket } from "node:net";
import { expect, test, type TestContext } from "vitest";
import { SkipError } from "@openwork/env";
import { isolatedRedis, isolatedRedisImage, isolatedRedisPing } from "../worlds/isolated-redis.ts";

async function checkBackend(backend: "native" | "docker", context: TestContext) {
  let redis: Awaited<ReturnType<typeof isolatedRedis>>;
  try { redis = await isolatedRedis({ backend }); }
  catch (error) {
    if (error instanceof SkipError) { context.skip(error.message); return; }
    throw error;
  }
  const port = redis.port;
  try {
    expect(redis.backend).toBe(backend);
    expect(redis.url).toBe(`redis://127.0.0.1:${port}`);
    expect(await isolatedRedisPing(port)).toBe(true);
  } finally { await redis[Symbol.asyncDispose](); }
  expect(await isolatedRedisPing(port)).toBe(false);
}

test("native Redis answers PING and stops only its owned process", async context => checkBackend("native", context));
test("Docker Redis uses an owned disposable service and removes its listener", { timeout: 240_000 }, async context => checkBackend("docker", context));

test("the Docker fallback uses the existing digest-pinned local Den image", async () => {
  expect(await isolatedRedisImage()).toMatch(/^redis:[^\s]+@sha256:[a-f0-9]{64}$/);
});

test("an open TCP port without a Redis PONG is not readiness", { timeout: 5_000 }, async () => {
  const sockets: Socket[] = [];
  const server = createServer(socket => { sockets.push(socket); socket.resume(); socket.end("+NOT_REDIS\r\n"); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("TCP fixture has no loopback port");
    expect(await isolatedRedisPing(address.port)).toBe(false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
