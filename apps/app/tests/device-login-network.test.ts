import { afterEach, expect, spyOn, test } from "bun:test";
import { fetchDenDeviceLogin } from "../src/app/lib/den-device-login";
import { desktopFetchViaMain } from "../src/app/lib/desktop";
import { DESKTOP_DEVICE_CLIENT_ID } from "../src/app/lib/device-login-flow";

const originalWindow = globalThis.window;
afterEach(() => Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow }));
const body = JSON.stringify({ client_id: DESKTOP_DEVICE_CLIENT_ID, device_code: "fixture-private-code" });

test.each(["https://api.example.test", "http://127.0.0.1:8788/api/den"])("file:// device requests use finite app transport for %s, never renderer CORS fetch", async (base) => {
  const calls: Array<{ command: string; url: string; init?: { method?: string; body?: string; timeoutMs?: number; redirect?: string; cancellable?: boolean; transferId?: string; headers?: Record<string, string> } }> = [];
  const raw = spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("Renderer fetch must not run."); });
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { protocol: "file:", origin: "null" },
    __OPENWORK_ELECTRON__: {
      invokeDesktop: async (command: string, url: string, init?: typeof calls[number]["init"]) => {
        calls.push({ command, url, init });
        return { status: 200, statusText: "OK", headers: [["content-type", "application/json"]], body: JSON.stringify({ ok: true }) };
      },
    },
  } });
  try {
    for (const endpoint of ["code", "token"]) {
      const response = await fetchDenDeviceLogin(`${base}/api/auth/device/${endpoint}`, { method: "POST", body, redirect: "error", signal: new AbortController().signal });
      expect(await response.json()).toEqual({ ok: true });
      expect(calls.at(-1)).toMatchObject({ command: "__fetch", url: `${base}/api/auth/device/${endpoint}`, init: { method: "POST", body, redirect: "error", timeoutMs: 10000, cancellable: true, transferId: expect.any(String) } });
    }
    await fetchDenDeviceLogin(`${base}/v1/me`, { headers: { Authorization: "Bearer fixture-session" }, redirect: "error", signal: new AbortController().signal });
    expect(calls.at(-1)?.init).toMatchObject({ headers: { authorization: "Bearer fixture-session" }, redirect: "error", timeoutMs: 10000, cancellable: true, transferId: expect.any(String) });
    expect(raw).not.toHaveBeenCalled();
  } finally { raw.mockRestore(); }
});

test.each(["caller", "deadline", "preaborted"])("device POST %s cancellation uses only its existing transfer", async (cause) => {
  const calls: string[] = [];
  let transferId: string | undefined;
  let rejectFetch = (_error: Error) => {};
  let entered = () => {};
  const dispatched = new Promise<void>((resolve) => { entered = resolve; });
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __OPENWORK_ELECTRON__: {
    invokeDesktop(command: string, value: string, init?: { transferId?: string }) {
      calls.push(command);
      if (command === "__cancelTransfer") {
        expect(value).toBe(transferId);
        rejectFetch(new Error("Transfer cancelled."));
        return Promise.resolve(true);
      }
      transferId = init?.transferId;
      entered();
      return new Promise((_resolve, reject) => { rejectFetch = reject; });
    },
  } } });
  const controller = new AbortController();
  const reason = new Error("Fixture cancelled.");
  if (cause === "preaborted") controller.abort(reason);
  const signal = cause === "deadline" ? AbortSignal.any([controller.signal, AbortSignal.timeout(20)]) : controller.signal;
  const pending = fetchDenDeviceLogin("https://api.example.test/api/auth/device/token", { method: "POST", body, redirect: "error", signal }).catch((error: unknown) => error);
  if (cause === "preaborted") {
    expect(await pending).toBe(reason);
    expect(calls).toEqual([]);
    return;
  }
  await dispatched;
  expect(transferId).toBeString();
  if (cause === "caller") controller.abort(reason);
  const result = await pending;
  if (cause === "caller") expect(result).toBe(reason);
  else expect(signal.aborted).toBe(true);
  expect(calls).toEqual(["__fetch", "__cancelTransfer"]);
});

test("ordinary POSTs including device-looking requests require explicit cancellation opt-in", async () => {
  const calls: Array<{ transferId?: string; redirect?: string; cancellable?: boolean }> = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __OPENWORK_ELECTRON__: {
    invokeDesktop: async (_command: string, _url: string, init: typeof calls[number]) => {
      calls.push(init);
      return { status: 200, statusText: "OK", headers: [], body: "true" };
    },
  } } });
  for (const [path, requestBody] of [
    ["/api/auth/device/code", body],
    ["/api/auth/device/token", body],
    ["/api/auth/device/token", JSON.stringify({ client_id: "openwork-cli" })],
    ["/api/auth/device/token", JSON.stringify({ client_id: "openwork-opencode-plugin" })],
    ["/api/auth/device/token", "not-json"],
    ["/api/auth/device/token/extra", body],
    ["/session/ses_fixture/prompt_async", body],
    ["/session/ses_fixture/command", body],
  ]) {
    await desktopFetchViaMain(`https://api.example.test${path}`, { method: "POST", body: requestBody, signal: new AbortController().signal });
    expect(calls.at(-1)?.transferId).toBeUndefined();
    expect(calls.at(-1)?.cancellable).toBe(false);
    expect(calls.at(-1)?.redirect).toBeUndefined();
  }
  const request = new Request("https://api.example.test/api/auth/device/code", { method: "POST", body, redirect: "error", signal: new AbortController().signal });
  await desktopFetchViaMain(request);
  expect(calls.at(-1)).toMatchObject({ cancellable: false, redirect: "error" });
  expect(calls.at(-1)?.transferId).toBeUndefined();
  await desktopFetchViaMain(request, { cancellable: true });
  expect(calls.at(-1)).toMatchObject({ transferId: expect.any(String), cancellable: true, redirect: "error" });
  await desktopFetchViaMain("https://api.example.test/ordinary?query=value", { method: "POST", body: "not-json", cancellable: true, signal: new AbortController().signal });
  expect(calls.at(-1)).toMatchObject({ transferId: expect.any(String), cancellable: true });
});

test("GET/PATCH and existing Stop/permission callers keep cancellation with query strings", async () => {
  const calls: Array<{ url: string; init: { transferId?: string; cancellable?: boolean } }> = [];
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __OPENWORK_ELECTRON__: {
    invokeDesktop: async (_command: string, url: string, init: typeof calls[number]["init"]) => {
      calls.push({ url, init });
      return { status: 200, statusText: "OK", headers: [], body: "true" };
    },
  } } });
  for (const [method, path] of [
    ["GET", "/session/ses_fixture"],
    ["PATCH", "/session/ses_fixture"],
    ["POST", "/session/ses_fixture/abort"],
    ["POST", "/permission/per_fixture/reply"],
  ]) {
    const url = `https://api.example.test${path}?directory=%2Ffixture`;
    await desktopFetchViaMain(url, { method, signal: new AbortController().signal });
    expect(calls.at(-1)).toMatchObject({ url, init: { cancellable: true, transferId: expect.any(String) } });
  }
});

test("web device requests retain native fetch and explicit redirect refusal", async () => {
  Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
  const raw = spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ ok: true }));
  const init = { method: "POST", body, redirect: "error" satisfies RequestRedirect, signal: new AbortController().signal };
  try {
    await fetchDenDeviceLogin("https://api.example.test/api/auth/device/code", init);
    expect(raw).toHaveBeenCalledWith("https://api.example.test/api/auth/device/code", init);
  } finally { raw.mockRestore(); }
});
