import { describe, expect, test } from "bun:test";

import { assertDesktopWebUrl, desktopFetch, desktopUploadMultipart } from "../src/app/lib/desktop";
import type { DesktopFetchInit, DesktopFetchResult } from "../src/app/lib/desktop-types";

describe("desktop external web URLs", () => {
  test("allows HTTP and HTTPS browser destinations", () => {
    expect(assertDesktopWebUrl("https://accounts.example.com/authorize?state=test")).toBe(
      "https://accounts.example.com/authorize?state=test",
    );
    expect(assertDesktopWebUrl("http://127.0.0.1:4319/callback")).toBe(
      "http://127.0.0.1:4319/callback",
    );
  });

  test("rejects custom protocols before Electron openExternal", () => {
    expect(() => assertDesktopWebUrl("javascript:alert(1)")).toThrow("not allowed");
    expect(() => assertDesktopWebUrl("file:///tmp/provider-controlled")).toThrow("not allowed");
    expect(() => assertDesktopWebUrl("openwork://provider-controlled")).toThrow("not allowed");
  });
});

describe("desktop fetch response bytes", () => {
  async function withBridge(result: DesktopFetchResult, run: (requests: Array<{ command: string; url: unknown; init?: DesktopFetchInit }>) => Promise<void>) {
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const requests: Array<{ command: string; url: unknown; init?: DesktopFetchInit }> = [];
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        __OPENWORK_ELECTRON__: {
          invokeDesktop: async (command: string, url: unknown, init?: DesktopFetchInit) => {
            requests.push({ command, url, init });
            return structuredClone(result);
          },
        },
      },
    });
    try {
      await run(requests);
    } finally {
      if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
      else Reflect.deleteProperty(globalThis, "window");
    }
  }

  test("preserves binary response bytes and request authentication across the bridge", async () => {
    const bytes = Uint8Array.from([0, 1, 127, 128, 200, 254, 255]);
    await withBridge({ status: 200, statusText: "OK", headers: [["content-type", "video/mp4"]], body: "", bodyBytes: bytes.buffer }, async (requests) => {
      const response = await desktopFetch(new Request("https://worker.example.test/video", {
        method: "POST", headers: { Authorization: "Bearer test", "Content-Type": "text/plain" }, body: "request text",
      }));
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      expect(response.headers.get("content-type")).toBe("video/mp4");
      expect(requests).toEqual([{
        command: "__fetch",
        url: "https://worker.example.test/video",
        init: {
          method: "POST", headers: { authorization: "Bearer test", "content-type": "text/plain" },
          body: "request text", responseType: "arraybuffer", timeoutMs: undefined, agentContextDiagnostics: undefined,
        },
      }]);
    });
  });

  test("retains text responses from older bridges and multipart uploads", async () => {
    const result = { status: 200, statusText: "OK", headers: [], body: '{"ok":true}' };
    await withBridge(result, async (requests) => {
      expect(await (await desktopFetch("https://worker.example.test/data")).json()).toEqual({ ok: true });
      expect(await desktopUploadMultipart(new File(["test"], "clip.mp4"), { url: "https://worker.example.test/inbox" })).toEqual(result);
      expect(requests[1]?.command).toBe("__uploadMultipart");
    });
  });

  test("decodes JSON bytes and keeps empty responses bodyless", async () => {
    await withBridge({ status: 200, statusText: "OK", headers: [], body: "", bodyBytes: new TextEncoder().encode('{"ok":true}').buffer }, async () => {
      expect(await (await desktopFetch("https://worker.example.test/data")).json()).toEqual({ ok: true });
    });
    for (const status of [204, 205, 304]) {
      await withBridge({ status, statusText: "", headers: [], body: "", bodyBytes: new ArrayBuffer(0) }, async () => {
        const response = await desktopFetch("https://worker.example.test/data");
        expect(response.status).toBe(status);
        expect(response.body).toBeNull();
        expect(await response.text()).toBe("");
      });
    }
  });
});
