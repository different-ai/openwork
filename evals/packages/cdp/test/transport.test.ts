import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import test from "node:test";
import type { Server } from "node:http";
import type { Duplex } from "node:stream";

import { callFunction, connect, evaluate } from "../src/cdp.ts";
import { evaluateOnSurface } from "../src/surface.ts";
import type { Surface } from "../src/surface.ts";

const TARGET_ID = "page-1";
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function portFromServer(server: Server): number {
  const address = server.address();
  if (typeof address === "object" && address !== null) return address.port;
  throw new Error("Test server did not expose a TCP port.");
}

function websocketFrame(payload: string): Buffer {
  const body = Buffer.from(payload);
  if (body.length < 126) return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(body.length, 2);
  return Buffer.concat([header, body]);
}

function handleClientFrames(socket: Duplex): void {
  let buffered = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= 2) {
      const lengthCode = buffered[1] & 0x7f;
      const lengthBytes = lengthCode === 126 ? 2 : 0;
      if (lengthCode === 127) throw new Error("Test websocket frame is unexpectedly large.");
      const headerLength = 2 + lengthBytes + 4;
      if (buffered.length < headerLength) return;
      const payloadLength = lengthCode === 126 ? buffered.readUInt16BE(2) : lengthCode;
      if (buffered.length < headerLength + payloadLength) return;
      const maskOffset = 2 + lengthBytes;
      const payload = Buffer.alloc(payloadLength);
      for (let index = 0; index < payloadLength; index += 1) {
        payload[index] = buffered[headerLength + index] ^ buffered[maskOffset + (index % 4)];
      }
      buffered = buffered.subarray(headerLength + payloadLength);
      const message: unknown = JSON.parse(payload.toString());
      if (!isRecord(message) || typeof message.id !== "number") continue;
      let result = {};
      if (message.method === "Runtime.evaluate") {
        const params = isRecord(message.params) ? message.params : {};
        result = params.expression === "globalThis"
          ? { result: { objectId: "global-object" } }
          : { result: { value: "recovered" } };
      } else if (message.method === "Runtime.callFunctionOn") {
        const params = isRecord(message.params) ? message.params : {};
        const args = Array.isArray(params.arguments) ? params.arguments : [];
        const first = args[0];
        result = { result: { value: isRecord(first) ? first.value : undefined } };
      }
      socket.write(websocketFrame(JSON.stringify({ id: message.id, result })));
    }
  });
}

async function startCdpServer(stalledConnections: number): Promise<{
  baseUrl: string;
  websocketUrl: string;
  connections(): number;
  close(): Promise<void>;
}> {
  const sockets = new Set<Duplex>();
  let connectionCount = 0;
  const server = createServer((request, response) => {
    if (request.url === "/json/version") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ Browser: "test" }));
      return;
    }
    if (request.url === "/json/list") {
      const port = portFromServer(server);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([{
        id: TARGET_ID,
        type: "page",
        title: "OpenWork",
        url: "http://127.0.0.1/app",
        webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${TARGET_ID}`,
      }]));
      return;
    }
    response.writeHead(404);
    response.end("not found");
  });
  server.on("upgrade", (request, socket) => {
    const key = request.headers["sec-websocket-key"];
    if (typeof key !== "string") {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));
    connectionCount += 1;
    if (connectionCount > stalledConnections) handleClientFrames(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = portFromServer(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    websocketUrl: `ws://127.0.0.1:${port}/devtools/page/${TARGET_ID}`,
    connections: () => connectionCount,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

test("a stalled websocket can be condemned without awaiting close", async () => {
  const server = await startCdpServer(1);
  try {
    const client = await connect(server.websocketUrl, { connectTimeoutMs: 500, sendTimeoutMs: 500 });
    await assert.rejects(evaluate(client, "1", { timeoutMs: 30 }), /CDP call Runtime\.evaluate timed out/);

    const pending = evaluate(client, "2", { timeoutMs: 500 });
    if (!client.abort) throw new Error("Connected CDP client did not expose abort().");
    const startedAt = Date.now();
    client.abort(new Error("probe timed out"));
    assert.ok(Date.now() - startedAt < 100, "abort() waited for the peer to complete websocket close");
    await assert.rejects(pending, /CDP transport stalled: probe timed out/);
    await assert.rejects(evaluate(client, "3", { timeoutMs: 500 }), /CDP socket is not open/);
  } finally {
    await server.close();
  }
});

test("function calls pass dynamic values as structured CDP arguments", async () => {
  const server = await startCdpServer(0);
  const client = await connect(server.websocketUrl, { connectTimeoutMs: 500, sendTimeoutMs: 500 });
  try {
    const dynamicValue = `"); throw new Error("must stay data"); //`;
    const value = await callFunction(client, "function (value) { return value; }", [dynamicValue]);
    assert.equal(value, dynamicValue);
  } finally {
    client.close();
    await server.close();
  }
});

test("surface evaluation heals after the first websocket consumes its budget", async () => {
  const server = await startCdpServer(1);
  try {
    const firstClient = await connect(server.websocketUrl, { connectTimeoutMs: 500, sendTimeoutMs: 500 });
    const surface: Surface = {
      handle: { name: "test", kind: "electron", hostKind: "test", cdpUrl: server.baseUrl },
      client: firstClient,
    };

    const value = await evaluateOnSurface(surface, "42", { timeoutMs: 30 });

    assert.equal(value, "recovered");
    assert.notEqual(surface.client, firstClient);
    assert.equal(server.connections(), 2);
  } finally {
    await server.close();
  }
});
