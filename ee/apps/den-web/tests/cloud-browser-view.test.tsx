import { afterAll, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

GlobalRegistrator.register();
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
afterAll(() => GlobalRegistrator.unregister());
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const requests = await import("../app/(den)/_lib/den-flow");
const input = await import("../app/(den)/_lib/cloud-browser-input");
const { CloudBrowserView } = await import("../app/(den)/_components/cloud-browser-view");

const tick = async (ms = 30) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };

type Status = { available: boolean; running: boolean; url: string | null; title: string | null };
type Call = { path: string; method: string; body: unknown };

async function mount(initial: Status, options: { onDone?: () => void; onSkip?: () => void } = {}) {
  let status = initial;
  const calls: Call[] = [];
  const json = spyOn(requests, "requestJson").mockImplementation(async (path, init = {}) => {
    const method = init.method ?? "GET";
    calls.push({ path, method, body: typeof init.body === "string" ? JSON.parse(init.body) : null });
    const payload = path === "/v1/cloud-browser" ? status : { ok: true };
    return { payload, response: Response.json(payload), text: JSON.stringify(payload) };
  });
  const blob = spyOn(requests, "requestBlob").mockImplementation(async () => (
    status.running
      ? { response: new Response(null, { status: 200 }), blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }) }
      : { response: new Response(null, { status: 409 }), blob: null }
  ));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<CloudBrowserView assistantName="WorkBot" onDone={options.onDone} onSkip={options.onSkip} expandHref="/browser" />));
  await tick();
  return {
    calls,
    container,
    setStatus(next: Status) { status = next; },
    inputs: () => calls.filter((call) => call.path === "/v1/cloud-browser/input").flatMap((call) => {
      const body = call.body;
      return typeof body === "object" && body !== null && "events" in body && Array.isArray(body.events) ? body.events : [];
    }),
    async close() {
      await act(async () => root.unmount());
      json.mockRestore();
      blob.mockRestore();
      container.remove();
    },
  };
}

function button(container: ParentNode, label: string) {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

test("take-over input maps the displayed frame to page pixels and batches typing", () => {
  expect(input.framePoint({ clientX: 320, clientY: 100, rect: { left: 0, top: 0, width: 640, height: 356.5 }, natural: { width: 1280, height: 713 } })).toEqual({ x: 640, y: 200 });
  expect(input.framePoint({ clientX: 700, clientY: 100, rect: { left: 0, top: 0, width: 640, height: 356.5 }, natural: { width: 1280, height: 713 } })).toBeNull();
  expect(input.keyIntent({ key: "a", metaKey: false, ctrlKey: false })).toEqual({ type: "text", text: "a" });
  expect(input.keyIntent({ key: " ", metaKey: false, ctrlKey: false })).toEqual({ type: "key", key: "Space" });
  expect(input.keyIntent({ key: "Enter", metaKey: false, ctrlKey: false })).toEqual({ type: "key", key: "Enter" });
  expect(input.keyIntent({ key: "v", metaKey: true, ctrlKey: false })).toBeNull();
  expect(input.keyIntent({ key: "Shift", metaKey: false, ctrlKey: false })).toBeNull();
  const queue = [
    { type: "text" as const, text: "p" },
    { type: "text" as const, text: "w" },
    { type: "key" as const, key: "Enter" as const },
    { type: "text" as const, text: "x" },
  ];
  expect(input.takeBatch(queue)).toEqual([{ type: "text", text: "pw" }, { type: "key", key: "Enter" }, { type: "text", text: "x" }]);
  expect(queue).toEqual([]);
  expect(input.textEvents("x".repeat(2_500)).map((event) => (event.type === "text" ? event.text.length : 0))).toEqual([2_000, 500]);
  expect(input.addressLabel("https://app.example.com/login?token=secret")).toBe("app.example.com/login");
  expect(input.clampWheel(5_000)).toBe(1_200);
});

test("waiting for the person, take over, sign in, done", async () => {
  let done = 0;
  const view = await mount({ available: true, running: true, url: "https://app.example.com/login?next=%2Finbox", title: "Sign in" }, { onDone: () => { done += 1; }, onSkip: () => {} });
  const text = () => view.container.textContent ?? "";
  expect(text()).toContain("app.example.com/login");
  expect(text()).not.toContain("next=");
  expect(text()).toContain("Waiting for you");
  expect(text()).toContain("Your password goes to app.example.com, not WorkBot");
  expect(button(view.container, "Skip for now")).toBeTruthy();

  await act(async () => button(view.container, "Take over").click());
  await tick();
  expect(text()).toContain("You're in control");

  const frame = view.container.querySelector('[role="group"]');
  const image = view.container.querySelector("img");
  if (!(frame instanceof HTMLElement) || !(image instanceof HTMLImageElement)) throw new Error("missing live frame");
  Object.defineProperty(image, "naturalWidth", { value: 1280 });
  Object.defineProperty(image, "naturalHeight", { value: 713 });
  image.getBoundingClientRect = () => new DOMRect(0, 0, 640, 356.5);

  await act(async () => { frame.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 320, clientY: 100, detail: 1 })); });
  for (const key of ["s", "3", "Enter"]) {
    await act(async () => { frame.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
  }
  await tick();
  const sent = view.inputs();
  expect(sent[0]).toEqual({ type: "click", x: 640, y: 200, clickCount: 1 });
  expect(sent.filter((event) => event.type === "text").map((event) => event.text).join("")).toBe("s3");
  expect(sent[sent.length - 1]).toEqual({ type: "key", key: "Enter" });

  await act(async () => button(view.container, "Done").click());
  await tick();
  expect(view.calls.some((call) => call.path === "/v1/cloud-browser/done" && call.method === "POST")).toBe(true);
  expect(done).toBe(1);
  expect(text()).toContain("Saved for next time");
  expect(text()).toContain("Tell WorkBot you're done.");
  await view.close();
});

test("nothing open and switched off give direction instead of a blank frame", async () => {
  const idle = await mount({ available: true, running: false, url: null, title: null });
  expect(idle.container.textContent).toContain("Nothing is open. Ask WorkBot to open the site again.");
  expect(idle.container.textContent).toContain("Not open");
  expect(idle.container.querySelector("img")).toBeNull();
  await idle.close();

  const off = await mount({ available: false, running: false, url: null, title: null });
  expect(off.container.textContent).toContain("Cloud browser isn't on for this workspace. OpenWork support can turn it on.");
  expect(off.calls.some((call) => call.path === "/v1/cloud-browser/screen")).toBe(false);
  await off.close();
});
