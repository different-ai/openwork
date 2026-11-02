import { describe, expect, test } from "bun:test";
import { forwardableProxyRequestHeaders } from "../src/server.js";

describe("forwardableProxyRequestHeaders", () => {
  test("drops expect and hop-by-hop headers that Node fetch (undici) rejects", () => {
    const headers = forwardableProxyRequestHeaders({
      "Expect": "100-continue",
      "Connection": "keep-alive",
      "Keep-Alive": "timeout=5",
      "Transfer-Encoding": "chunked",
      "Upgrade": "h2c",
      "TE": "gzip",
      "Host": "127.0.0.1:1234",
      "Origin": "http://localhost",
      "Authorization": "Bearer client",
      "X-OpenWork-Host-Token": "secret",
      "X-OpenWork-Client-Id": "client",
      "Content-Type": "application/json",
      "X-Custom": "kept",
    });
    for (const name of ["expect", "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "host", "origin", "authorization", "x-openwork-host-token", "x-openwork-client-id"]) {
      expect(headers.has(name)).toBe(false);
    }
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-custom")).toBe("kept");
  });

  test("sanitized headers are accepted by fetch", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const headers = forwardableProxyRequestHeaders({ "Expect": "100-continue", "Content-Type": "application/json" });
      const response = await fetch(`http://127.0.0.1:${server.port}/`, { method: "POST", headers, body: "{}" });
      expect(await response.text()).toBe("ok");
    } finally {
      server.stop(true);
    }
  });
});
