import { afterEach, expect, jest, test } from "bun:test";
import { desktopFetchViaMain } from "../src/app/lib/desktop";
import { createClient, createDesktopFetch } from "../src/app/lib/opencode";

const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;
afterEach(() => {
  jest.useRealTimers();
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
});

test("archive opts finite loopback GET/PATCH into IPC with credentials and scope, without changing default or SSE routing", async () => {
  const ipc: { command: string; args: unknown[] }[] = [];
  const renderer: Request[] = [];
  const raw: typeof fetch = async (input, init) => {
    renderer.push(new Request(input, init));
    return Response.json({ id: "ses_fixture" });
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: raw });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    fetch: raw,
    __OPENWORK_ELECTRON__: { invokeDesktop: async (command: string, ...args: unknown[]) => {
      ipc.push({ command, args });
      return { status: 200, statusText: "OK", headers: [["content-type", "application/json"]], body: JSON.stringify({ id: "ses_fixture" }) };
    } },
  } });
  const base = "http://127.0.0.1:8788/workspace/ws_fixture/opencode";
  const auth = { token: "fixture-only", mode: "openwork" } satisfies Parameters<typeof createClient>[2];
  const client = createClient(base, "/fixture/a", auth, { desktopTransport: "main" });
  const signal = new AbortController().signal;
  await client.session.get({ sessionID: "ses_fixture", directory: "/fixture/a" }, { signal });
  await client.session.update({ sessionID: "ses_fixture", directory: "/fixture/a", time: { archived: 123 } }, { signal });
  expect(renderer).toHaveLength(0);
  expect(ipc).toHaveLength(2);
  expect(structuredClone(ipc[0])).toMatchObject({ command: "__fetch", args: [expect.stringContaining("/session/ses_fixture"), {
    method: "GET", headers: { authorization: "Bearer fixture-only" }, transferId: expect.any(String),
  }] });
  expect(structuredClone(ipc[1])).toMatchObject({ command: "__fetch", args: [expect.stringContaining("/session/ses_fixture"), {
    method: "PATCH", body: JSON.stringify({ time: { archived: 123 } }), transferId: expect.any(String),
  }] });
  for (const call of ipc) {
    const url = call.args[0];
    if (typeof url !== "string") throw new Error("Missing serialized SDK URL");
    expect(new URL(url).searchParams.get("directory")).toBe("/fixture/a");
  }
  await createClient(base, "/fixture/a", auth).session.get({ sessionID: "ses_fixture" });
  expect(renderer).toHaveLength(1);
  const finite = async () => { throw new Error("SSE must not enter the buffering IPC transport"); };
  await createDesktopFetch(auth, finite)(`${base}/event`, { headers: { Accept: "text/event-stream" } });
  expect(renderer).toHaveLength(2);
  expect(ipc).toHaveLength(2);
});

test("Stop's transport timeout cancels the native IPC request, without giving prompt or command POSTs read cancellation", async () => {
  jest.useFakeTimers();
  const calls: string[] = [];
  let transferId: string | undefined;
  let rejectFetch: ((error: Error) => void) | undefined;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __OPENWORK_ELECTRON__: {
    invokeDesktop: (command: string, value: string, init?: { transferId?: string }) => {
      calls.push(command);
      if (command === "__cancelTransfer") {
        expect(value).toBe(transferId);
        rejectFetch?.(new Error("IPC request aborted"));
        return Promise.resolve(true);
      }
      transferId = init?.transferId;
      return new Promise((_resolve, reject) => { rejectFetch = reject; });
    },
  } } });
  const finite = createDesktopFetch(undefined, desktopFetchViaMain);
  const abort = finite("http://127.0.0.1:8788/workspace/ws_fixture/opencode/session/ses_fixture/abort?directory=/fixture/a", { method: "POST" })
    .catch((error: unknown) => error);
  expect(transferId).toBeString();
  jest.advanceTimersByTime(10_000);
  expect(await abort).toMatchObject({ message: "Request timed out." });
  expect(calls).toEqual(["__fetch", "__cancelTransfer"]);
  for (const path of ["prompt_async", "command"]) {
    calls.length = 0;
    const request = finite(`http://127.0.0.1:8788/session/ses_fixture/${path}`, { method: "POST", body: "{}" })
      .catch((error: unknown) => error);
    expect(transferId).toBeUndefined();
    jest.advanceTimersByTime(10_000);
    expect(calls).toEqual(["__fetch"]);
    // Commands intentionally have no transport deadline, and prompt admission
    // has a longer one. Settle the mock explicitly rather than await either.
    rejectFetch?.(new Error("test cleanup"));
    await request;
    expect(calls).toEqual(["__fetch"]);
  }
});
