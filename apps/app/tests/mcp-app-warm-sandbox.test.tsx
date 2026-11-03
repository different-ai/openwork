/** @jsxImportSource react */
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { OpenworkServerClient } from "../src/app/lib/openwork-server";

const ownsDom = !GlobalRegistrator.isRegistered;
// happy-dom loads no iframe page by default, so frames would have no window.
if (ownsDom) GlobalRegistrator.register({ url: "https://web.example/", settings: { enableIframePageLoading: true } });
afterAll(async () => { if (ownsDom) await GlobalRegistrator.unregister(); });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { McpAppWarmSandbox } = await import("../src/components/chat/mcp-app-warm-sandbox");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

const SANDBOX_ORIGIN = "https://sandbox.example";
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
function client(expectedOrigin = SANDBOX_ORIGIN) {
  const mcpAppSandbox = () => ({ url: "about:blank#warm", expectedOrigin, sandbox: "allow-scripts allow-same-origin" });
  return { mcpAppSandbox } as unknown as OpenworkServerClient;
}
const frame = () => host.querySelector<HTMLIFrameElement>("[data-mcp-app-warm-sandbox]");
async function render(value: OpenworkServerClient) {
  await act(async () => root.render(<McpAppWarmSandbox client={value} />));
}
async function ready(source: unknown, origin = SANDBOX_ORIGIN, method = "ui/notifications/sandbox-proxy-ready") {
  await act(async () => { window.dispatchEvent(new MessageEvent("message", { source: source as Window, origin, data: { method } })); });
}
beforeEach(() => { host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

test("it stays out of sight and out of the tab order, and starts the sandbox with the same restrictions as an App", async () => {
  await render(client());
  const iframe = frame();
  expect(iframe?.hasAttribute("hidden")).toBe(true);
  expect(iframe?.getAttribute("tabindex")).toBe("-1");
  expect(iframe?.getAttribute("aria-hidden")).toBe("true");
  expect(iframe?.getAttribute("referrerpolicy")).toBe("no-referrer");
  expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
  expect(iframe?.getAttribute("src")).toBe("about:blank#warm");
});

test("it is not an App, so nothing that looks for open Apps finds it", async () => {
  await render(client());
  expect(host.querySelector("[data-mcp-app-resource]")).toBeNull();
});

test("once the sandbox is ready it loads one empty document, and only that", async () => {
  await render(client());
  const target = frame()?.contentWindow;
  if (!target) throw new Error("Missing frame window");
  const post = spyOn(target, "postMessage").mockImplementation(() => {});
  await ready(target);
  expect(post).toHaveBeenCalledTimes(1);
  const [message, origin] = post.mock.calls[0] as unknown as [{ method: string; params: { html: string; sandbox: string } }, string];
  expect(origin).toBe(SANDBOX_ORIGIN);
  expect(message.method).toBe("ui/notifications/sandbox-resource-ready");
  expect(message.params.sandbox).toBe("allow-scripts");
  expect(message.params.html).toBe("<!doctype html><html><head></head><body></body></html>");
  await ready(target);
  expect(post).toHaveBeenCalledTimes(1);
});

test("a sandbox on an opaque origin is still reached", async () => {
  await render(client("null"));
  const target = frame()?.contentWindow;
  if (!target) throw new Error("Missing frame window");
  const post = spyOn(target, "postMessage").mockImplementation(() => {});
  await ready(target, "null");
  expect(post.mock.calls[0]?.[1]).toBe("*");
});

test("it ignores a ready message from any other window, origin or method", async () => {
  await render(client());
  const target = frame()?.contentWindow;
  if (!target) throw new Error("Missing frame window");
  const post = spyOn(target, "postMessage").mockImplementation(() => {});
  await ready(window);
  await ready(target, "https://other.example");
  await ready(target, SANDBOX_ORIGIN, "something/else");
  expect(post).not.toHaveBeenCalled();
});

test("a sandbox that resolves to the host's own origin never starts", async () => {
  await render(client(window.location.origin));
  expect(frame()?.getAttribute("src")).toBeNull();
});

test("leaving stops listening and closes the sandbox", async () => {
  const remove = spyOn(window, "removeEventListener");
  await render(client());
  const iframe = frame();
  await act(async () => root.render(<div />));
  expect(remove.mock.calls.some(([name]) => name === "message")).toBe(true);
  expect(iframe?.getAttribute("src")).toBeNull();
  remove.mockRestore();
});

test("a new client starts a new sandbox", async () => {
  const first = client();
  await render(first);
  const spy = spyOn(window, "addEventListener");
  await render(client());
  expect(spy.mock.calls.filter(([name]) => name === "message")).toHaveLength(1);
  spy.mockRestore();
});
