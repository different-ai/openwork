import assert from "node:assert/strict";
import { connect } from "node:net";
import test from "node:test";
import { evidenceCdpRelay } from "../src/freestyle-evidence.ts";

test("host CDP relay refuses browser-originated HTTP and WebSocket requests before adding credentials", async () => {
  await using relay = await evidenceCdpRelay({ cdpOrigin: `https://cdp-${"a".repeat(32)}.preview.openwork.software`, cookie: "__Host-openwork-preview=synthetic" });
  const blockedHeaders: Record<string, string>[] = [{ origin: "https://unrelated.example" }, { "sec-fetch-site": "cross-site" }];
  for (const headers of blockedHeaders) {
    const response = await fetch(`${relay.url}/json/list`, { headers });
    assert.equal(response.status, 403);
  }
  const url = new URL(relay.url);
  const response = await new Promise<string>((resolve, reject) => {
    let data = "";
    const socket = connect(Number(url.port), "127.0.0.1", () => {
      socket.write(`GET /devtools/page/test HTTP/1.1\r\nHost: ${url.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nOrigin: https://unrelated.example\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    });
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("Relay denial timed out")); });
    socket.on("error", reject); socket.on("data", (chunk) => { data += chunk.toString(); }); socket.on("end", () => resolve(data));
  });
  assert.match(response, /^HTTP\/1.1 403/);
  assert.doesNotMatch(response, /synthetic/);
});
