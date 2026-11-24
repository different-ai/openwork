import { afterEach, expect, test, vi } from "vitest";
import type { Surface } from "@openwork/cdp";
import { quitDesktop } from "./desktop.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function surface(closeError?: Error): Surface {
  return {
    handle: { name: "packaged", kind: "electron", hostKind: "daytona", cdpUrl: "https://desktop.example.test" },
    client: { close() {}, async send() { if (closeError) throw closeError; return {}; } },
  };
}

test("a stopped CDP backend behind a live proxy completes graceful quit", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => new Response("Bad Gateway", { status: 502 }));
  vi.stubGlobal("fetch", fetch);
  const quit = quitDesktop(surface()).catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await quit).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("quit keeps waiting while CDP responds successfully", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response("{}", { status: 200 }))
    .mockResolvedValueOnce(new Response("{}", { status: 200 }))
    .mockResolvedValue(new Response("Bad Gateway", { status: 502 }));
  vi.stubGlobal("fetch", fetch);
  const quit = quitDesktop(surface()).catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await quit).toBeUndefined();
  expect(fetch).toHaveBeenCalledTimes(3);
});

test("an app that keeps serving CDP still fails the quit deadline", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  const quit = quitDesktop(surface()).catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await quit).toEqual(new Error("Desktop did not quit within 30000ms."));
});

test("unexpected proxy HTTP errors do not count as a successful quit", async () => {
  for (const status of [401, 403, 404, 500]) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Unavailable", { status })));
    await expect(quitDesktop(surface())).rejects.toThrow(`Could not verify desktop quit: CDP endpoint returned HTTP ${status}.`);
  }
});

test("the proxy shutdown exception is limited to Daytona", async () => {
  const app = surface();
  app.handle.hostKind = "local";
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad Gateway", { status: 502 })));
  await expect(quitDesktop(app)).rejects.toThrow("Could not verify desktop quit: CDP endpoint returned HTTP 502.");
});

test("only the expected websocket closure during Browser.close is tolerated", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Connection refused"); }));
  await expect(quitDesktop(surface(new Error("CDP websocket closed.")))).resolves.toBeUndefined();
  const failure = new Error("Browser.close permission denied");
  await expect(quitDesktop(surface(failure))).rejects.toBe(failure);
});
