import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { assertAbsent, clickTarget, DisabledTargetError, locate, MISS_CANDIDATE_LIMIT, TargetNotFoundError, mapKey, parseTarget, pressKey, readDom, waitForLocated } from "../src/input.ts";
import type { Surface } from "../src/surface.ts";

function surfaceReturning(value: unknown): Surface {
  return {
    handle: { name: "input-test", kind: "electron", hostKind: "test", cdpUrl: "http://127.0.0.1:1" },
    client: {
      async send(method) {
        if (method === "Runtime.evaluate") return { result: { objectId: "global" } };
        if (method === "Runtime.callFunctionOn") return { result: { value } };
        throw new Error(`Unexpected CDP method ${method}.`);
      },
      close() {},
    },
  };
}

test("parseTarget normalizes bare, structured, and regular-expression targets", () => {
  assert.deepEqual(parseTarget("composer"), {
    bare: { kind: "string", value: "composer" },
    nth: 0,
    composer: true,
  });
  assert.deepEqual(parseTarget({ role: "textbox", label: /password/i, nth: 1 }), {
    text: undefined,
    role: "textbox",
    label: { kind: "regexp", value: "password", flags: "i" },
    placeholder: undefined,
    testId: undefined,
    nth: 1,
    composer: false,
  });
  assert.deepEqual(parseTarget({ role: "button", text: /^Model\b/i }), {
    text: { kind: "regexp", value: "^Model\\b", flags: "i" },
    role: "button",
    label: undefined,
    placeholder: undefined,
    testId: undefined,
    nth: 0,
    composer: false,
  });
  assert.equal(parseTarget({ role: "switch", label: "Check automatically" }).role, "switch");
  assert.equal(parseTarget({ role: "progressbar", label: "Weekly usage limit remaining" }).role, "progressbar");
});

test("mapKey produces CDP key fields and modifier bits", () => {
  assert.deepEqual(mapKey("Enter"), {
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
    modifiers: 0,
  });
  assert.deepEqual(mapKey("Meta+R"), {
    key: "R",
    code: "KeyR",
    windowsVirtualKeyCode: 82,
    modifiers: 4,
  });
  assert.throws(() => mapKey("Hyper+R"), /Unsupported modifier/);
});

test("locate reports visible button and link names when no target matches", async () => {
  const surface = surfaceReturning({
    notFound: true,
    candidates: ['button "Model · gpt-5"', 'link "Provider docs"'],
  });
  await assert.rejects(
    locate(surface, { role: "button", text: "Missing" }),
    /Visible button\/link candidates \(2\): button "Model · gpt-5", link "Provider docs"\./,
  );
});

test("a miss names the route, the page roots, and every candidate of the requested role", async () => {
  const surface = surfaceReturning({
    notFound: true,
    candidateRole: "menuitem",
    candidates: ['menuitem "Remove Team briefing from dashboard"', 'menuitem "Delete Team briefing"'],
    route: "#/dashboard",
    roots: { appHeader: true, dashboardPage: false },
  });
  await assert.rejects(
    locate(surface, { role: "menuitem", text: "Missing" }),
    /Route #\/dashboard\. Page roots: appHeader=true dashboardPage=false\. Visible menuitem candidates \(2\): menuitem "Remove Team briefing from dashboard", menuitem "Delete Team briefing"\./,
  );
});

test("a miss caps the candidate list and says how many the page really had", async () => {
  const candidates = Array.from({ length: MISS_CANDIDATE_LIMIT + 3 }, (_, index) => `button "Control ${index}"`);
  const surface = surfaceReturning({ notFound: true, candidateRole: "button", candidates });
  await assert.rejects(
    locate(surface, { role: "button", text: "Missing" }),
    (error: unknown) => {
      assert.ok(error instanceof TargetNotFoundError);
      assert.match(error.message, new RegExp(`Visible button candidates \\(${MISS_CANDIDATE_LIMIT + 3}\\) \\(showing first ${MISS_CANDIDATE_LIMIT} of ${MISS_CANDIDATE_LIMIT + 3}\\): `));
      assert.match(error.message, /button "Control 39"\.$/);
      assert.doesNotMatch(error.message, /Control 40/);
      return true;
    },
  );
  await assert.rejects(
    locate(surfaceReturning({ notFound: true, candidateRole: "tab", candidates: [] }), { role: "tab", text: "Missing" }),
    /No visible tab candidates\./,
  );
});

test("the browser-side miss report lists every rendered element of the requested role, not the first few buttons", async () => {
  // Run the serialized page callback against a minimal DOM: a shell rail of buttons first in
  // document order, then a dashboard page whose menu items are the controls a spec would look for.
  class Element {
    tagName: string;
    attributes: Record<string, string>;
    innerText: string;
    textContent: string;
    parentElement: Element | null = null;
    children: Element[] = [];
    labels = [];
    constructor(tagName: string, attributes: Record<string, string>, text: string) {
      this.tagName = tagName.toUpperCase();
      this.attributes = attributes;
      this.innerText = text;
      this.textContent = text;
    }
    getAttribute(name: string) { return this.attributes[name] ?? null; }
    hasAttribute(name: string) { return name in this.attributes; }
    closest() { return null; }
    getBoundingClientRect() { return { left: 0, top: 0, width: 10, height: 10, x: 0, y: 0 }; }
  }
  class HTMLElement extends Element { isContentEditable = false; }
  class HTMLInputElement extends HTMLElement {}
  class HTMLTextAreaElement extends HTMLElement {}
  class HTMLSelectElement extends HTMLElement {}
  class HTMLButtonElement extends HTMLElement {}
  const button = (text: string) => new HTMLButtonElement("button", {}, text);
  const menuItem = (text: string) => new HTMLElement("div", { role: "menuitem" }, text);
  const rail = ["Home", "Sessions", "Library", "Dashboard", "Settings", "Help", "Account", "Toggle Sidebar", "Notifications"].map(button);
  const menu = [menuItem("Remove Team briefing from dashboard"), menuItem("Delete Team briefing")];
  const dashboardRoot = new HTMLElement("div", { "data-dashboard-page": "" }, "");
  const interactive = [...rail, ...menu];
  const progressbar = new HTMLElement("div", { role: "progressbar", "aria-label": "Weekly usage limit remaining" }, "");
  const document = {
    querySelectorAll(selector: string) {
      if (selector.includes('[role="progressbar"]')) return [...interactive, progressbar];
      return selector.includes('[role="menuitem"]') ? interactive : rail;
    },
    querySelector(selector: string) {
      return selector === "[data-dashboard-page]" ? dashboardRoot : null;
    },
    getElementById() { return null; },
  };
  const surface = surfaceReturning(null);
  surface.client.send = async (method, params) => {
    if (method === "Runtime.evaluate") return { result: { objectId: "global" } };
    assert.equal(method, "Runtime.callFunctionOn");
    assert.ok(params && typeof params.functionDeclaration === "string" && Array.isArray(params.arguments));
    const [argument] = params.arguments;
    assert.ok(argument && typeof argument === "object" && "value" in argument && typeof argument.value === "string");
    const value = runInNewContext(`(${params.functionDeclaration})(${JSON.stringify(argument.value)})`, {
      document,
      location: { hash: "#/dashboard", pathname: "/" },
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      Element, HTMLElement, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, HTMLButtonElement,
      JSON, String, Number, Boolean, Array, Object, RegExp,
    });
    return { result: { value } };
  };
  await assert.rejects(
    locate(surface, { role: "menuitem", text: "Missing" }),
    /Route #\/dashboard\. Page roots: appHeader=false dashboardPage=true\. Visible menuitem candidates \(2\): menuitem "Remove Team briefing from dashboard", menuitem "Delete Team briefing"\.$/,
  );
  await assert.rejects(
    locate(surface, { role: "progressbar", label: "Missing" }),
    /Visible progressbar candidates \(1\): progressbar "Weekly usage limit remaining"\./,
  );
  // A role-less miss keeps the historical button/link list, now without the DOM-order cap.
  await assert.rejects(
    locate(surface, "Missing"),
    /Visible button\/link candidates \(9\): button "Home", .*button "Notifications"\.$/,
  );
});

test("role targets locate labelled progress bars such as usage meters", async () => {
  class Element {
    tagName: string;
    attributes: Record<string, string>;
    innerText = "";
    textContent = "";
    parentElement: Element | null = null;
    children: Element[] = [];
    labels = [];
    constructor(tagName: string, attributes: Record<string, string>) {
      this.tagName = tagName.toUpperCase();
      this.attributes = attributes;
    }
    getAttribute(name: string) { return this.attributes[name] ?? null; }
    hasAttribute(name: string) { return name in this.attributes; }
    closest() { return null; }
    contains(other: Element) { return other === this; }
    matches() { return false; }
    scrollIntoView() {}
    getBoundingClientRect() { return { left: 100, top: 200, width: 300, height: 6, x: 100, y: 200 }; }
  }
  class HTMLElement extends Element { isContentEditable = false; }
  class HTMLInputElement extends HTMLElement {}
  class HTMLTextAreaElement extends HTMLElement {}
  class HTMLSelectElement extends HTMLElement {}
  class HTMLButtonElement extends HTMLElement {}
  const meters = ["5 hour", "Weekly", "Monthly"].map((window) => new HTMLElement("div", { role: "progressbar", "aria-label": `${window} usage limit remaining` }));
  const document = {
    // Mirror the browser: an element is only a candidate when the selector names its role.
    querySelectorAll(selector: string) { return selector.includes('[role="progressbar"]') ? meters : []; },
    querySelector() { return null; },
    getElementById() { return null; },
    elementFromPoint() { return meters[0]; },
  };
  const surface = surfaceReturning(null);
  surface.client.send = async (method, params) => {
    if (method === "Runtime.evaluate") return { result: { objectId: "global" } };
    assert.equal(method, "Runtime.callFunctionOn");
    assert.ok(params && typeof params.functionDeclaration === "string" && Array.isArray(params.arguments));
    const [argument] = params.arguments;
    assert.ok(argument && typeof argument === "object" && "value" in argument && typeof argument.value === "string");
    const value = runInNewContext(`(${params.functionDeclaration})(${JSON.stringify(argument.value)})`, {
      document,
      location: { hash: "", pathname: "/dashboard/ai-gateway" },
      innerWidth: 1440,
      innerHeight: 1100,
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
      Element, HTMLElement, HTMLInputElement, HTMLTextAreaElement, HTMLSelectElement, HTMLButtonElement,
      JSON, String, Number, Boolean, Array, Object, RegExp,
    });
    return { result: { value } };
  };
  const located = await locate(surface, { role: "progressbar", label: "5 hour usage limit remaining" });
  assert.equal(located.name, "5 hour usage limit remaining");
  assert.equal(located.visible, true);
  assert.equal(located.hitTestOk, true);
});

test("key dispatch leaves native codes to Chrome and retains explicit editing commands", async () => {
  const surface = surfaceReturning(null);
  const events: unknown[] = [];
  surface.client.send = async (method, params) => {
    assert.equal(method, "Input.dispatchKeyEvent");
    events.push(params);
    return {};
  };
  await pressKey(surface, "Meta+ArrowDown");
  await pressKey(surface, "Escape");
  assert.deepEqual(events, [
    { type: "keyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, modifiers: 4, commands: ["moveToEndOfDocument"] },
    { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, modifiers: 4 },
    { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, modifiers: 0 },
    { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, modifiers: 0 },
  ]);
});

test("click readiness waits for stable geometry rather than hitting a moving menu option", async () => {
  const surface = surfaceReturning(null);
  let inspections = 0;
  surface.client.send = async (method) => {
    if (method === "Runtime.evaluate") return { result: { objectId: "global" } };
    assert.equal(method, "Runtime.callFunctionOn");
    const y = Math.min(inspections++, 2) * 20;
    return { result: { value: {
      center: { x: 50, y: y + 25 }, rect: { x: 0, y, width: 100, height: 50 },
      tag: "button", name: "CustomExact", visible: true, hitTestOk: true,
      editable: false, disabled: null, value: "", text: "CustomExact", covering: null,
    } } };
  };
  const target = await waitForLocated(surface, "CustomExact", { mustHitTest: true, timeoutMs: 2_000 });
  assert.equal(inspections, 4);
  assert.equal(target.rect.y, 40);
});

test("waitForLocated identifies the element covering a visible target", async () => {
  const surface = surfaceReturning({
    center: { x: 50, y: 25 },
    rect: { x: 0, y: 0, width: 100, height: 50 },
    tag: "button",
    name: "Run task",
    visible: true,
    hitTestOk: false,
    editable: false,
    disabled: null,
    value: "",
    text: "Run task",
    covering: { tag: "div", role: "dialog", text: "Blocking overlay" },
  });
  await assert.rejects(
    waitForLocated(surface, "Run task", { mustHitTest: true, timeoutMs: 10 }),
    /visible=true, hitTestOk=false\. Covered by div role="dialog" text="Blocking overlay"/,
  );
});


test("only a successful browser inspection can report a missing target", async () => {
  await assert.rejects(locate(surfaceReturning({ notFound: true }), "Missing"), TargetNotFoundError);
  await assert.rejects(locate(surfaceReturning(null), "Missing"), error =>
    error instanceof Error && !(error instanceof TargetNotFoundError));
  const disconnected = surfaceReturning(null);
  disconnected.client.send = async () => { throw new Error("CDP disconnected"); };
  await assert.rejects(locate(disconnected, "Missing"), /CDP disconnected/);
});


test("absence never turns disconnection or malformed browser results into a pass", async () => {
  await assertAbsent(surfaceReturning({ notFound: true }), "Missing", 10);
  await assert.rejects(assertAbsent(surfaceReturning(null), "Missing", 10), /Could not locate/);
  await assert.rejects(assertAbsent(surfaceReturning({ center: {}, rect: {} }), "Missing", 10), /invalid located-element geometry/);
  const disconnected = surfaceReturning(null);
  disconnected.client.send = async () => { throw new Error("CDP disconnected"); };
  await assert.rejects(assertAbsent(disconnected, "Missing", 10), /CDP disconnected/);
  await assert.rejects(assertAbsent(surfaceReturning(null), "Missing", 0), /positive duration/);
});

test("absence distinguishes a hidden target from a visible target", async () => {
  const target = { center: { x: 1, y: 1 }, rect: { x: 0, y: 0, width: 2, height: 2 }, tag: "div", name: "Error", visible: false, hitTestOk: false, editable: false, disabled: null, value: "", text: "Error", covering: null };
  await assertAbsent(surfaceReturning(target), "Error", 10);
  await assert.rejects(assertAbsent(surfaceReturning({ ...target, visible: true }), "Error", 10), /remained visible/);
});

test("DOM inspection projects geometry and focus without exposing input values", async () => {
  const input = { tagName: "INPUT", textContent: "", value: "private-password", getBoundingClientRect: () => ({ left: 1, right: 101, top: 2, bottom: 22, width: 100, height: 20 }) };
  const surface = surfaceReturning(null);
  surface.client.send = async (method, params) => {
    if (method === "Runtime.evaluate") return { result: { objectId: "global" } };
    assert.equal(method, "Runtime.callFunctionOn");
    assert.ok(params && typeof params.functionDeclaration === "string");
    assert.deepEqual(params.arguments, [{ value: "input" }]);
    const value = runInNewContext(`(${params.functionDeclaration})("input")`, {
      document: { documentElement: { clientWidth: 390, scrollWidth: 400 }, activeElement: input,
        querySelectorAll(selector: string) { assert.equal(selector, "input"); return [input]; } },
    });
    return { result: { value } };
  };
  const result = await readDom(surface, "input");
  assert.equal(result.elements[0]?.focused, true);
  assert.equal(result.elements[0]?.rect.width, 100);
  assert.equal(result.documentWidth > result.viewportWidth, true);
  assert.equal(JSON.stringify(result).includes("private-password"), false);
  assert.equal(input.value, "private-password");
  await assert.rejects(readDom(surfaceReturning(null), "input"), /invalid snapshot/);
  await assert.rejects(readDom(surfaceReturning({ viewportWidth: 390, documentWidth: 390, elements: [{}] }), "input"), /invalid snapshot/);
});

const enabledButton = {
  center: { x: 50, y: 25 },
  rect: { x: 0, y: 0, width: 100, height: 50 },
  tag: "button",
  name: "Run task",
  visible: true,
  hitTestOk: true,
  editable: false,
  disabled: null,
  value: "",
  text: "Run task",
  covering: null,
};

function surfaceLocating(values: unknown[]): { surface: Surface; mouse: Array<Record<string, unknown>> } {
  const mouse: Array<Record<string, unknown>> = [];
  const queue = [...values];
  const surface: Surface = {
    handle: { name: "input-test", kind: "electron", hostKind: "test", cdpUrl: "http://127.0.0.1:1" },
    client: {
      async send(method, params = {}) {
        if (method === "Runtime.evaluate") return { result: { objectId: "global" } };
        if (method === "Runtime.callFunctionOn") return { result: { value: queue.length > 1 ? queue.shift() : queue[0] } };
        if (method === "Input.dispatchMouseEvent") { mouse.push(params); return {}; }
        throw new Error(`Unexpected CDP method ${method}.`);
      },
      close() {},
    },
  };
  return { surface, mouse };
}

test("clickTarget refuses a disabled or aria-disabled control by name instead of dispatching a click", async () => {
  for (const disabled of ["disabled", 'aria-disabled="true"']) {
    const { surface, mouse } = surfaceLocating([{ ...enabledButton, disabled }]);
    // waitForLocated needs two inspections with stable geometry before it can hand the target over.
    await assert.rejects(clickTarget(surface, "Run task", { timeoutMs: 500 }), (error: unknown) =>
      error instanceof DisabledTargetError
      && error.message.includes('disabled button "Run task"')
      && error.message.includes(`(${disabled})`));
    assert.deepEqual(mouse, []);
  }
});

test("clickTarget rejects a malformed disabled state instead of guessing", async () => {
  const { surface, mouse } = surfaceLocating([{ ...enabledButton, disabled: false }]);
  await assert.rejects(clickTarget(surface, "Run task", { timeoutMs: 20 }), /invalid located-element geometry/);
  assert.deepEqual(mouse, []);
});

test("clickTarget re-locates immediately before dispatch and clicks the fresh center", async () => {
  const moved = { ...enabledButton, center: { x: 50, y: 49 }, rect: { x: 0, y: 24, width: 100, height: 50 } };
  // Two stable inspections satisfy waitForLocated; the third is the re-locate right before dispatch.
  const { surface, mouse } = surfaceLocating([enabledButton, enabledButton, moved]);
  const clicked = await clickTarget(surface, "Run task", { clickCount: 2 });
  assert.deepEqual(clicked.rect, moved.rect);
  assert.deepEqual(mouse.map((event) => [event.type, event.x, event.y, event.clickCount]), [
    ["mouseMoved", 50, 49, undefined],
    ["mousePressed", 50, 49, 2],
    ["mouseReleased", 50, 49, 2],
  ]);
});

test("clickTarget fails with both rects when the target moves out of reach before dispatch", async () => {
  const covered = { ...enabledButton, rect: { x: 0, y: 24, width: 100, height: 50 }, hitTestOk: false, covering: { tag: "div", role: "", text: "Loading" } };
  const { surface, mouse } = surfaceLocating([enabledButton, enabledButton, covered]);
  await assert.rejects(clickTarget(surface, "Run task"), /"Run task" moved before the click could be dispatched: 0,0 100×50 → 0,24 100×50 \(visible=true, hitTestOk=false\)\. Covered by div text="Loading"/);
  assert.deepEqual(mouse, []);
  const disabledLate = surfaceLocating([enabledButton, enabledButton, { ...enabledButton, disabled: "disabled" }]);
  await assert.rejects(clickTarget(disabledLate.surface, "Run task"), DisabledTargetError);
  assert.deepEqual(disabledLate.mouse, []);
});

function appFrameSurface(options: { disabled?: boolean; covered?: boolean; missingDocument?: boolean; resourceUri?: string } = {}) {
  const mouse: Record<string, unknown>[] = [];
  const button = { nodeId: 7, backendNodeId: 70, nodeName: "BUTTON", attributes: options.disabled ? ["disabled", ""] : [],
    children: [{ nodeId: 8, backendNodeId: 80, nodeName: "#text", nodeValue: "Authenticate" }] };
  const heading = { nodeId: 9, backendNodeId: 90, nodeName: "H1", children: [{ nodeId: 10, backendNodeId: 100, nodeName: "#text", nodeValue: "Notion connected" }] };
  const surface = surfaceReturning(null);
  surface.client.send = async (method, params = {}) => {
    if (method === "DOM.enable" || method === "CSS.enable" || method === "DOM.scrollIntoViewIfNeeded") return {};
    if (method === "DOM.getDocument") return { root: { nodeId: 1, backendNodeId: 10, nodeName: "#document", children: [
      { ...button, nodeId: 11, backendNodeId: 110 },
      { nodeId: 2, backendNodeId: 20, nodeName: "DIV", attributes: ["data-mcp-app-resource", options.resourceUri ?? "ui://connection"], children: [
        { nodeId: 3, backendNodeId: 30, nodeName: "IFRAME", contentDocument: options.missingDocument ? undefined : {
          nodeId: 4, backendNodeId: 40, nodeName: "#document", children: [
            { nodeId: 5, backendNodeId: 50, nodeName: "IFRAME", contentDocument: { nodeId: 6, backendNodeId: 60, nodeName: "#document", children: [button, heading] } },
          ],
        } },
      ] },
    ] } };
    if (method === "DOM.getBoxModel") { assert.ok(params.nodeId === 7 || params.nodeId === 9); return { model: { content: [100, 200, 200, 200, 200, 240, 100, 240] } }; }
    if (method === "DOM.getNodeForLocation") return { backendNodeId: options.covered ? 110 : 70 };
    if (method === "CSS.getComputedStyleForNode") return { computedStyle: [{ name: "visibility", value: "visible" }] };
    if (method === "Input.dispatchMouseEvent") { mouse.push(params); return {}; }
    throw new Error(`Unexpected CDP method ${method}`);
  };
  return { surface, mouse };
}

const appAuthenticate = { mcpApp: { resourceUri: "ui://connection" }, role: "button", label: "Authenticate" } satisfies Exclude<import("../src/input.ts").Target, string>;

test("MCP App targets resolve nested frame DOM, not a same-named host button", async () => {
  const { surface, mouse } = appFrameSurface();
  const found = await clickTarget(surface, appAuthenticate, { timeoutMs: 1_000 });
  assert.equal(found.name, "Authenticate");
  assert.deepEqual(mouse.map(event => [event.type, event.x, event.y]), [
    ["mouseMoved", 150, 220], ["mousePressed", 150, 220], ["mouseReleased", 150, 220],
  ]);
});

test("MCP App targets retain disabled and hit-test guards", async () => {
  const disabled = appFrameSurface({ disabled: true });
  await assert.rejects(clickTarget(disabled.surface, appAuthenticate, { timeoutMs: 1_000 }), DisabledTargetError);
  assert.deepEqual(disabled.mouse, []);
  const covered = appFrameSurface({ covered: true });
  await assert.rejects(clickTarget(covered.surface, appAuthenticate, { timeoutMs: 150 }), /hitTestOk=false/);
  assert.deepEqual(covered.mouse, []);
});

test("unreadable frame documents cannot establish absence or fall back to the host control", async () => {
  const missing = appFrameSurface({ missingDocument: true });
  await assert.rejects(assertAbsent(missing.surface, appAuthenticate, 100), /frame documents unavailable/);
  assert.deepEqual(missing.mouse, []);
  const other = appFrameSurface({ resourceUri: "ui://another-app" });
  await assert.rejects(locate(other.surface, appAuthenticate), TargetNotFoundError);
  assert.deepEqual(other.mouse, []);
  await assert.rejects(assertAbsent(surfaceReturning(null), appAuthenticate, 100), /Unexpected CDP method/);
});

test("trusted input reaches an isolated MCP App iframe in Chrome", { skip: process.env.OPENWORK_CDP_FRAME_CHROME ? false : "needs: OPENWORK_CDP_FRAME_CHROME", timeout: 30_000 }, async () => {
  const { createServer } = await import("node:http");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { attachSurface, evaluateOnSurface } = await import("../src/surface.ts");
  await using cleanup = new AsyncDisposableStack();
  const profile = await mkdtemp(join(tmpdir(), "openwork-frame-input-"));
  cleanup.defer(() => rm(profile, { recursive: true, force: true }));
  let port = 0;
  let trusted = 0;
  const server = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    if (request.url === "/decision") { trusted += 1; response.end("ok"); return; }
    if (request.url === "/frame") {
      const html = `<h1>Connect Notion</h1><button onclick="if(event.isTrusted){document.querySelector('h1').textContent='Notion connected';fetch('http://127.0.0.1:${port}/decision',{mode:'no-cors'});this.remove()}">Authenticate</button>`;
      response.end(`<iframe sandbox="allow-scripts" style="width:500px;height:200px" srcdoc="${html.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>`);
    } else response.end(`<button>Authenticate</button><div style="height:420px"></div><button onclick="document.body.dataset.clicked='yes'">Reachable action</button><div data-mcp-app-resource="ui://connection" style="padding:80px"><iframe sandbox="allow-scripts allow-same-origin" style="width:600px;height:300px" src="http://127.0.0.1:${port}/frame"></iframe></div>`);
  });
  await new Promise<void>(resolve => server.listen(0, "::", resolve));
  cleanup.defer(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture port unavailable");
  port = address.port;
  const browser = spawn(process.env.OPENWORK_CDP_FRAME_CHROME ?? "", ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", `http://localhost:${port}`], { stdio: ["ignore", "ignore", "pipe"] });
  cleanup.defer(async () => {
    if (browser.exitCode !== null || browser.signalCode !== null) return;
    const exited = new Promise<void>(resolve => browser.once("exit", () => resolve()));
    browser.kill();
    await exited;
  });
  const cdpUrl = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not expose CDP")), 10_000);
    browser.once("error", error => { clearTimeout(timer); reject(error); });
    browser.stderr.on("data", data => {
      output += String(data);
      const match = output.match(/DevTools listening on ws:\/\/([^/]+)/);
      if (match) { clearTimeout(timer); resolve(`http://${match[1]}`); }
    });
  });
  const surface = await attachSurface({ name: "isolated-frame-input", kind: "chrome", hostKind: "local", cdpUrl });
  cleanup.use(surface);
  await surface.client.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  await clickTarget(surface, { role: "button", label: "Reachable action" });
  assert.equal(await evaluateOnSurface(surface, () => document.body.dataset.clicked), "yes");
  assert.equal(await evaluateOnSurface(surface, () => scrollY), 0, "clicking an already reachable action must not move its hover target");
  await surface.client.send("Emulation.setDeviceMetricsOverride", { width: 800, height: 1200, deviceScaleFactor: 1, mobile: false });
  await clickTarget(surface, appAuthenticate, { timeoutMs: 10_000 });
  const outcome = await waitForLocated(surface, { mcpApp: { resourceUri: "ui://connection" }, role: "heading", text: "Notion connected" }, { timeoutMs: 10_000 });
  assert.equal(outcome.visible, true);
  assert.equal(trusted, 1);
  await assertAbsent(surface, appAuthenticate, 100);
});
