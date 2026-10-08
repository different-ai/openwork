import { connect } from "node:net";
import type { Socket } from "node:net";
import { expect } from "vitest";
import { eventually, needs, test } from "@openwork/testkit";
import { bootManagedInference } from "../worlds/managed-inference.ts";

/**
 * Cloudflare answers 524 when the gateway sends no response headers for ~100s,
 * and cloudflared reuses idle origin connections for up to 90s. This boots the
 * real gateway with a 1s response-start window (production: 20s) and a slow
 * provider, and checks both: slow streaming requests get headers early, and
 * idle keep-alive connections outlive Node's 5s default.
 */

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function events(text: string): Record<string, unknown>[] {
  return text.split(/\r?\n/).filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
    .map((line) => JSON.parse(line.slice(6))).filter(record);
}

function readHttpResponse(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = "";
    const onData = (chunk: Buffer) => {
      text += chunk.toString("utf8");
      const headerEnd = text.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const head = text.slice(0, headerEnd);
      const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? NaN);
      const complete = Number.isFinite(length)
        ? Buffer.byteLength(text.slice(headerEnd + 4)) >= length
        : /transfer-encoding:\s*chunked/i.test(head) && text.endsWith("0\r\n\r\n");
      if (complete) {
        socket.off("data", onData);
        socket.off("close", onClose);
        resolve(text);
      }
    };
    const onClose = () => reject(new Error(`Socket closed before a full response: ${text.slice(0, 200)}`));
    socket.on("data", onData);
    socket.once("close", onClose);
  });
}

test("slow providers get early stream headers and idle tunnel connections stay open", { timeout: 180000 }, async ({ place, evidence }) => {
  needs({ placement: "local" });
  await using world = await bootManagedInference(place, {
    env: { GATEWAY_RESPONSE_START_MS: "1000", GATEWAY_RESPONSE_HEARTBEAT_MS: "1000", INFERENCE_UPSTREAM_TIMEOUT_MS: "6000" },
  });
  const { key } = world.identity;
  const chat = (body: Record<string, unknown> = {}, signal: AbortSignal = AbortSignal.timeout(20000)) => fetch(`${world.url}/api/v1/chat/completions`, {
    method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    signal, body: JSON.stringify({ model: "z-ai/glm-5.2", messages: [{ role: "user", content: "private fixture prompt" }], stream: true, ...body }),
  });
  const claim = (name: string, detail: string) => evidence.recordAssertionEvidence(name, detail, true);

  // Fast answers are unchanged: real status, Retry-After, and no heartbeat.
  world.witness.mode("rate-limit");
  const fastLimited = await chat();
  expect(fastLimited.status).toBe(429);
  expect(fastLimited.headers.get("retry-after")).toBe("7");
  await fastLimited.text();
  // first-frame sends no provider heartbeat, so every ": processing" below is the gateway's.
  world.witness.mode("first-frame");
  const fast = await (await chat()).text();
  expect(fast).not.toContain(": processing");
  expect(fast).toContain("[DONE]");
  claim("Fast provider answers keep their HTTP status", "A provider answering within the response-start window still yields HTTP 429 with Retry-After 7, and a fast success has no heartbeat frames.");

  // A slow provider that succeeds: headers come at the window, the answer follows.
  world.witness.delayHeaders(3000);
  const slowStarted = Date.now();
  const slow = await chat();
  const headersAfter = Date.now() - slowStarted;
  expect(slow.status).toBe(200);
  expect(headersAfter).toBeGreaterThanOrEqual(900);
  expect(headersAfter).toBeLessThan(2500);
  expect(slow.headers.get("content-type")).toContain("text/event-stream");
  expect(slow.headers.get("x-openwork-request-id")).toMatch(/^[0-9a-f]{32}$/);
  const slowText = await slow.text();
  expect(slowText.startsWith(": processing\n\n")).toBe(true);
  expect(slowText.match(/Complete café/g)).toHaveLength(1);
  expect(slowText.match(/\[DONE\]/g)).toHaveLength(1);
  expect(events(slowText).find((event) => event.usage)?.usage).toMatchObject({ total_tokens: 24 });
  claim("A slow provider no longer holds back response headers", `With the provider silent for 3s and a 1s window, headers arrived after ${headersAfter} ms; heartbeats preceded the complete answer, usage and one DONE.`);

  // A slow provider that then fails: one OpenAI-style error event, no DONE, no provider text.
  world.witness.mode("rate-limit");
  const slowLimited = await chat();
  expect(slowLimited.status).toBe(200);
  const slowLimitedText = await slowLimited.text();
  const errorEvent = events(slowLimitedText).find((event) => record(event.error));
  expect(errorEvent).toMatchObject({ error: { code: "upstream_rate_limited" } });
  expect(slowLimitedText).not.toContain("[DONE]");
  expect(slowLimitedText).not.toContain("private provider");
  claim("A provider failure after the window becomes a stream error event", "A 429 that arrives after the headers were committed is sent as one SSE error event with the gateway's safe code, without DONE or the provider's private message.");

  // A provider that never answers: the gateway's own header timeout ends the stream.
  world.witness.delayHeaders(0);
  world.witness.mode("header-stall");
  const stalledStarted = Date.now();
  const stalled = await chat();
  expect(Date.now() - stalledStarted).toBeLessThan(2500);
  const stalledText = await stalled.text();
  expect(Date.now() - stalledStarted).toBeGreaterThanOrEqual(5500);
  expect(stalledText.match(/: processing/g)?.length ?? 0).toBeGreaterThanOrEqual(4);
  expect(events(stalledText).find((event) => record(event.error))).toMatchObject({ error: { code: "upstream_timeout" } });
  expect(stalledText).not.toContain("[DONE]");
  claim("A provider that never answers ends with a timeout event", "Headers were committed within the window, heartbeats kept arriving each second, and the 6s upstream timeout ended the stream with upstream_timeout instead of a proxy 524.");

  // Leaving while the provider is still silent cancels the provider request.
  world.witness.mode("success");
  world.witness.delayHeaders(5000);
  const count = world.witness.requests.length;
  const leave = new AbortController();
  const left = await chat({}, leave.signal);
  expect(left.status).toBe(200);
  const reader = left.body?.getReader();
  if (!reader) throw new Error("Missing committed body");
  await reader.read();
  const request = world.witness.requests[count];
  if (!request) throw new Error("Missing provider request");
  leave.abort();
  await reader.cancel().catch(() => {});
  await eventually(() => request.cancelled, { within: 2000, intervalMs: 20 });
  expect(world.witness.requests.length).toBe(count + 1);
  world.witness.delayHeaders(0);
  claim("Leaving a held stream cancels the provider request", "Aborting the client while the provider had not answered closed the provider connection within 2s, with no second attempt.");

  // Idle keep-alive sockets must outlive cloudflared's reuse of pooled connections.
  const { hostname, port } = new URL(world.url);
  const socket = connect({ host: hostname, port: Number(port) });
  await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
  let closedAt: number | null = null;
  socket.once("close", () => { closedAt = Date.now(); });
  const healthRequest = `GET /health HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: keep-alive\r\n\r\n`;
  const pending = readHttpResponse(socket);
  socket.write(healthRequest);
  expect(await pending).toMatch(/^HTTP\/1\.1 200/);
  await new Promise((resolve) => setTimeout(resolve, 6500));
  expect(closedAt).toBeNull();
  const reused = readHttpResponse(socket);
  socket.write(healthRequest);
  expect(await reused).toMatch(/^HTTP\/1\.1 200/);
  socket.destroy();
  claim("Idle keep-alive connections survive past Node's 5s default", "One TCP connection served /health, stayed open through 6.5s of idleness, and served a second request; cloudflared can reuse pooled connections without racing an origin close.");
});
