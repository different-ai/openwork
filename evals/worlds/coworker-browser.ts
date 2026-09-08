import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalIn, waitFor } from "@openwork/behaviors";
import { browserScript, browserSource, clickAt, connect, debuggerUrlFor, evaluate, listTargets } from "@openwork/cdp";
import { needs, SkipError, type Place, type Seed } from "@openwork/env";
import { coworker, localHost } from "@openwork/hosts";
import { record, scriptedToolModel, type ToolReceipt } from "../packages/labs/src/scripted-tool-model.ts";

export const BROWSER_START = "Keep the browser review in this private discussion.";
export const BROWSER_INSPECT = "Open the review page, inspect its initial state, and take a screenshot. Keep the page in this discussion.";
export const BROWSER_REVIEW = "In the reopened review page, increment the counter once and replace the draft with Reviewed in Coworker. Check the result and take a screenshot.";
export const BROWSER_OTHER = "Start a separate browser review. Leave my other discussion and its page alone while I switch back to it.";
export const BROWSER_REOPEN = "Check the reopened review page in this discussion.";
export const BROWSER_HANDOFF = "Let me handle the sign-in step on this disposable review page, then check it without changing anything.";

function receipt(receipts: ToolReceipt[], id: string) {
  const found = receipts.find((item) => item.id === id);
  if (!found) throw new Error(`No native browser receipt for ${id}`);
  return found;
}

function result(receipts: ToolReceipt[], id: string): unknown {
  return JSON.parse(receipt(receipts, id).output);
}

function handle(receipts: ToolReceipt[], id = "open") {
  const value = result(receipts, id);
  const tab = Array.isArray(value) ? value[0] : value;
  if (!record(tab) || typeof tab.browser_url !== "string" || typeof tab.target_id !== "string") {
    throw new Error(`No owned page handle at ${id}: ${JSON.stringify(value)}`);
  }
  return { browser_url: tab.browser_url, target_id: tab.target_id };
}

function input(receipts: ToolReceipt[], id: string, label: string) {
  const value = result(receipts, id);
  if (!record(value) || typeof value.snapshot_id !== "string" || typeof value.snapshot !== "string") throw new Error(`No snapshot receipt at ${id}`);
  const line = value.snapshot.split("\n").find((candidate) => candidate.match(/\] (?:button|textbox) "([^"]*)"/)?.[1]?.trim() === label);
  const uid = line?.match(/\[(?:uid=)?(\d+)\]/)?.[1];
  if (!uid) throw new Error(`No UID for ${label}: ${value.snapshot}`);
  return { ...handle(receipts, "reopened-tabs"), snapshot_id: value.snapshot_id, uid: Number(uid) };
}

export async function coworkerBrowserWorld(_seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("local Coworker browser only; no remote substitution");
  needs({ placement: "local", commands: ["opencode"] });
  const stack = new AsyncDisposableStack();
  let logPath: string | undefined;
  try {
    const origin = "http://coworker-browser.test";
    const requests: string[] = [];
    // The native launch parser accepts single-token switches. An exact-host HTTP
    // proxy avoids OS DNS edits and never exposes a localhost top-level page.
    const fixture = createServer((request, response) => {
      const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
      if (url.origin !== origin || request.method !== "GET") { response.writeHead(403); response.end(); return; }
      requests.push(url.pathname);
      if (url.pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
      const title = url.pathname === "/other" ? "Other review" : "Browser review";
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end(`<!doctype html><html lang="en"><head><title>${title}</title></head>
        <body role="main" aria-label="Review workspace" style="margin:16px;font:16px system-ui;background:#f5f1e8;color:#172b35">
        <h1>${title}</h1><button id="increment">Increment</button> <output id="count">0</output>
        <label>Draft text <input id="draft" value="Initial draft"></label>
        <script>document.getElementById('increment').onclick=()=>{const count=document.getElementById('count');count.textContent=String(Number(count.textContent)+1)};</script></body></html>`);
    });
    fixture.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"));
    await new Promise<void>((resolve, reject) => { fixture.once("error", reject); fixture.listen(0, "127.0.0.1", resolve); });
    stack.defer(async () => { fixture.closeAllConnections(); await new Promise<void>((resolve, reject) => fixture.close((error) => error ? reject(error) : resolve())); });
    const address = fixture.address();
    if (!address || typeof address === "string") throw new Error("Browser fixture did not bind a local port");
    const pageObservation = () => {
      const count = document.getElementById("count");
      const draft = document.querySelector<HTMLInputElement>("#draft");
      if (!count || !draft) throw new Error("No review page state");
      return { title: document.title, url: location.href, count: Number(count.textContent), draft: draft.value, width: innerWidth, height: innerHeight };
    };
    const pageExpression = browserSource(pageObservation);
    // Tool input is executable source; probes themselves remain typed and read-only.
    const deniedEdit = browserSource(() => {
      const count = document.getElementById("count");
      if (!count) throw new Error("No fixture counter");
      count.textContent = "999";
    });
    const model = stack.use(await scriptedToolModel([
      { prompt: BROWSER_START, reply: "The browser discussion is ready.", steps: [] },
      { prompt: BROWSER_INSPECT, reply: "The browser inspection is complete.", steps: [
        { id: "open", name: "coworker_browser_open", args: { url: `${origin}/review` } },
        { id: "snapshot", name: "coworker_browser_snapshot", args: (r) => handle(r), gate: "page-ready" },
        { id: "eval", name: "coworker_browser_eval", args: (r) => ({ ...handle(r), expression: pageExpression }) },
        { id: "screenshot", name: "coworker_browser_screenshot", args: (r) => handle(r) },
        { id: "tabs", name: "coworker_browser_tabs", args: {} },
      ] },
      { prompt: BROWSER_OTHER, reply: "The separate browser review is ready.", steps: [
        { id: "other-tabs-before", name: "coworker_browser_tabs", args: {} },
        { id: "cross-snapshot", name: "coworker_browser_snapshot", args: (r) => handle(r) },
        { id: "cross-eval", name: "coworker_browser_eval", args: (r) => ({ ...handle(r), expression: deniedEdit }) },
        { id: "cross-close", name: "coworker_browser_close", args: (r) => handle(r) },
        { id: "other-open", name: "coworker_browser_open", args: { url: `${origin}/other` }, gate: "background" },
        { id: "other-eval", name: "coworker_browser_eval", args: (r) => ({ ...handle(r, "other-open"), expression: pageExpression }) },
        { id: "other-tabs-after", name: "coworker_browser_tabs", args: {} },
      ] },
      { prompt: BROWSER_REOPEN, reply: "The reopened browser page is ready.", steps: [
        { id: "reopened-tabs", name: "coworker_browser_tabs", args: {} },
        { id: "reopened-snapshot", name: "coworker_browser_snapshot", args: (r) => handle(r, "reopened-tabs") },
        { id: "reopened-eval", name: "coworker_browser_eval", args: (r) => ({ ...handle(r, "reopened-tabs"), expression: pageExpression }) },
      ] },
      // Sign-in is only a handoff checkpoint on the disposable fixture; no login or credentials are used.
      { prompt: BROWSER_HANDOFF, reply: "The browser sign-in checkpoint is complete.", steps: [
        { id: "handoff-before", name: "coworker_browser_snapshot", args: (r) => handle(r, "reopened-tabs") },
        { id: "handoff", name: "coworker_browser_handoff", args: (r) => ({ ...handle(r, "reopened-tabs"), reason: "sign-in" }) },
        { id: "handoff-stale-eval", name: "coworker_browser_eval", args: (r) => ({ ...handle(r, "reopened-tabs"), expression: deniedEdit }) },
        { id: "handoff-stale-navigate", name: "coworker_browser_navigate", args: (r) => ({ ...handle(r, "reopened-tabs"), url: `${origin}/must-not-navigate` }) },
        { id: "handoff-stale-click", name: "coworker_browser_click", args: (r) => input(r, "handoff-before", "Increment") },
        { id: "handoff-stale-fill", name: "coworker_browser_fill", args: (r) => ({ ...input(r, "handoff-before", "Draft text"), value: "Must not be applied" }) },
        { id: "handoff-fresh", name: "coworker_browser_snapshot", args: (r) => handle(r, "reopened-tabs") },
        { id: "handoff-eval", name: "coworker_browser_eval", args: (r) => ({ ...handle(r, "reopened-tabs"), expression: pageExpression }) },
      ] },
      { prompt: BROWSER_REVIEW, reply: "The browser review is complete.", steps: [
        { id: "takeover-read", name: "coworker_browser_snapshot", args: (r) => handle(r, "reopened-tabs"), gate: "takeover" },
        { id: "takeover-edit", name: "coworker_browser_eval", args: (r) => ({ ...handle(r, "reopened-tabs"), expression: deniedEdit }) },
        { id: "snapshot-click", name: "coworker_browser_snapshot", args: (r) => handle(r, "reopened-tabs"), gate: "takeover-resume" },
        { id: "click", name: "coworker_browser_click", args: (r) => input(r, "snapshot-click", "Increment"), gate: "controls-input" },
        { id: "stale-click", name: "coworker_browser_click", args: (r) => input(r, "snapshot-click", "Increment") },
        { id: "snapshot-fill", name: "coworker_browser_snapshot", args: (r) => handle(r, "reopened-tabs") },
        { id: "fill", name: "coworker_browser_fill", args: (r) => ({ ...input(r, "snapshot-fill", "Draft text"), value: "Reviewed in Coworker" }) },
        { id: "review-eval", name: "coworker_browser_eval", args: (r) => ({ ...handle(r, "reopened-tabs"), expression: pageExpression }) },
        { id: "review-screenshot", name: "coworker_browser_screenshot", args: (r) => handle(r, "reopened-tabs") },
      ] },
    ]));
    // Same isolated native-engine setup as coworker-computer-control, without
    // that world's native helper or macOS Accessibility/Screen Recording gate.
    const profileDir = await mkdtemp(join(await realpath(tmpdir()), "coworker-browser-"));
    stack.defer(() => rm(profileDir, { recursive: true, force: true }));
    const provider = { "eval-browser": { npm: "@ai-sdk/openai-compatible", name: "Local browser witness", options: { baseURL: model.baseUrl, apiKey: "eval-only" }, models: { scripted: { name: "Scripted", tool_call: true, limit: { context: 65536, output: 4096 } } } } };
    const cleared = Object.fromEntries(Object.keys(process.env).filter((key) => /^(OPENCODE_|COWORKER_)/.test(key) || /(_API_KEY|_ACCESS_TOKEN|_AUTH_TOKEN)$/.test(key)).map((key) => [key, ""]));
    const host = stack.use(localHost());
    const app = stack.use(await coworker({ name: "discussion-browser", host, profileDir, env: {
      ...cleared,
      ELECTRON_EXTRA_LAUNCH_ARGS: `--proxy-server=http://127.0.0.1:${address.port}`,
      COWORKER_HOME_DIR: join(profileDir, "coworkers"),
      COWORKER_USER_DATA_DIR: join(profileDir, "electron-userdata"),
      COWORKER_SERVER_CONFIG: join(profileDir, "coworker-server.json"),
      OPENWORK_RUNTIME_DB: join(profileDir, "runtime.sqlite"),
      OPENWORK_SERVER_STATE_PATH: join(profileDir, "server-state.json"),
      OPENWORK_SERVER_TOKEN_STORE_PATH: join(profileDir, "server-tokens.json"),
      OPENCODE_CONFIG_DIR: join(profileDir, "opencode-config"),
      OPENCODE_DB: join(profileDir, "opencode.db"),
      CODEX_HOME: join(profileDir, "codex"),
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ["eval-browser"], provider }),
    } }));
    logPath = app.handle.meta?.log;
    const invoke = async (command: string, payload: Record<string, unknown> = {}) => {
      // A state-changing IPC must not use the read helper's automatic replay on timeout.
      const envelope = await evaluate(app.client, browserScript((command, payload): unknown => {
        const bridge: unknown = Reflect.get(window, "__COWORKER__");
        if (!bridge || typeof bridge !== "object" || !("invoke" in bridge) || typeof bridge.invoke !== "function") throw new Error("Coworker bridge is unavailable");
        return bridge.invoke(command, payload);
      }, [command, payload]), { awaitPromise: true, timeoutMs: 180_000 });
      if (!record(envelope) || envelope.ok !== true || !record(envelope.result)) throw new Error(`Coworker arrangement failed: ${command}: ${JSON.stringify(envelope)}`);
      return envelope.result;
    };
    const created = await invoke("coworkers.create", { name: "Editor", role: "Writing partner", mission: "Review only the disposable browser fixture.", avatarColor: "blue", avatarGlasses: "round", personality: "neutral" });
    if (typeof created.workspaceId !== "string" || !created.workspaceId) throw new Error("No native coworker workspace");
    await invoke("coworkers.update", { slug: "editor", patch: { model: "eval-browser/scripted", modelVariant: "" } });
    const runtime = await invoke("runtime.info");
    if (typeof runtime.serverUrl !== "string" || typeof runtime.ownerToken !== "string" || new URL(runtime.serverUrl).hostname !== "127.0.0.1") throw new Error("Coworker did not launch a local native server");
    const response = await fetch(`${runtime.serverUrl}/workspace/${encodeURIComponent(created.workspaceId)}/opencode/provider`, { headers: { Authorization: `Bearer ${runtime.ownerToken}` }, signal: AbortSignal.timeout(30_000) });
    const providers: unknown = await response.json();
    if (!response.ok || !record(providers) || JSON.stringify(providers.connected) !== JSON.stringify(["eval-browser"])) throw new Error("The native engine must connect only the local browser model witness");
    await evalIn(app, browserScript(() => { location.reload(); return true; }, []));
    await app.client.send("Page.bringToFront");
    await waitFor(app, browserScript(() => document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() === "Ready" && [...document.querySelectorAll<HTMLElement>('textarea[aria-label="Message Editor"]')].some((node) => node.checkVisibility()), []), { timeoutMs: 180_000, label: "isolated native browser discussion visible and ready" });
    const pageSurface = async (id = "open") => {
      const owned = handle(model.receipts, id);
      const target = (await listTargets(owned.browser_url)).find((item) => item.id === owned.target_id);
      if (!target) throw new Error("Owned browser target is not live");
      const client = await connect(debuggerUrlFor(owned.browser_url, target));
      stack.defer(() => client.close());
      return { handle: { ...app.handle, name: "owned-review-page", cdpUrl: owned.browser_url }, client };
    };
    return {
      app, model, origin, requests, pageSurface,
      result: (id: string) => result(model.receipts, id),
      receipt: (id: string) => receipt(model.receipts, id),
      handle: (id = "open") => handle(model.receipts, id),
      async screenshotSize(id = "screenshot") {
        const output = receipt(model.receipts, id).output;
        const file = output.match(/(?:\/[^\n"']+\.png)/)?.[0];
        if (!file) throw new Error(`Native screenshot did not return a PNG path: ${output}`);
        const png = await readFile(file);
        if (png.toString("hex", 0, 8) !== "89504e470d0a1a0a") throw new Error("Native screenshot is not a PNG");
        stack.defer(() => rm(file, { force: true }));
        return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
      },
      async page(id = "open") {
        const owned = handle(model.receipts, id);
        const target = (await listTargets(owned.browser_url)).find((item) => item.id === owned.target_id);
        if (!target) throw new Error("Owned browser target is not live");
        const client = await connect(debuggerUrlFor(owned.browser_url, target));
        try { return await evaluate(client, pageObservation); } finally { client.close(); }
      },
      async clickWatchIncrement(id = "open") {
        const page = await pageSurface(id);
        const point = await evaluate(page.client, browserScript(() => {
          const rect = document.getElementById("increment")?.getBoundingClientRect();
          if (!rect) throw new Error("No fixture Increment button");
          return { x: (rect.x + rect.width / 2) / innerWidth, y: (rect.y + rect.height / 2) / innerHeight };
        }, []));
        const target = await evalIn(app, browserScript((point) => {
          const image = document.querySelector<HTMLImageElement>('[data-testid="coworker-browser-watch-image"]');
          if (!image?.complete || !image.naturalWidth) throw new Error("No loaded watch image");
          const rect = image.getBoundingClientRect();
          const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
          const width = image.naturalWidth * scale;
          const height = image.naturalHeight * scale;
          const x = rect.x + (rect.width - width) / 2 + point.x * width;
          const y = rect.y + (rect.height - height) / 2 + point.y * height;
          if (!document.elementFromPoint(x, y)?.closest('[data-testid="coworker-browser-watch"]')) throw new Error("Watch image is covered");
          return { x, y };
        }, [point]));
        await clickAt(app, target);
      },
      async narrowDesktopViewport() {
        await app.client.send("Emulation.setDeviceMetricsOverride", { width: 860, height: 860, deviceScaleFactor: 1, mobile: false });
      },
      async ui() {
        return await evalIn(app, browserScript(() => {
          const get = (id: string) => [...document.querySelectorAll<HTMLElement>('[data-testid="' + id + '"]')].find((node) => node.checkVisibility());
          const viewport = get('coworker-browser-viewport')?.getBoundingClientRect();
          const panel = get('context-panel');
          const thumbnail = document.querySelector<HTMLImageElement>('[data-testid="coworker-browser-thumbnail"]');
          const watch = document.querySelector<HTMLImageElement>('[data-testid="coworker-browser-watch-image"]');
          return { idle: get('coworker-thread-status')?.dataset.state === 'idle',
            discussion: get('coworker-discussion-switcher')?.textContent?.trim(),
            activeDiscussion: document.querySelector<HTMLElement>('[data-testid="coworker-discussion-menu"] [aria-checked="true"]')?.dataset.threadId,
            browserOpen: Boolean(get('coworker-browser-panel')),
            browserPreview: Boolean(get('coworker-browser-preview')),
            mode: get('coworker-browser-panel')?.dataset.mode,
            modal: Boolean(get('coworker-browser-modal')),
            control: get('coworker-browser-viewport')?.dataset.control,
            handoff: Boolean(get('coworker-browser-handoff')),
            thumbnail: thumbnail ? { loaded: thumbnail.complete && thumbnail.naturalWidth > 0 && thumbnail.naturalHeight > 0 } : null,
            watchImage: watch ? { loaded: watch.complete && watch.naturalWidth > 0 && watch.naturalHeight > 0 } : null,
            tabs: [...document.querySelectorAll('[aria-label="Browser tabs"] [role="tab"]')].map(tab => ({ title: tab.textContent, selected: tab.getAttribute('aria-selected') })),
            bounds: viewport ? { x: viewport.x, y: viewport.y, width: viewport.width, height: viewport.height } : null,
            aside: { tag: panel?.tagName, overlay: panel?.dataset.overlay, view: panel?.dataset.view, collapsed: panel?.dataset.collapsed, depth: panel?.dataset.depth, width: panel?.getBoundingClientRect().width } };
        }, []));
      },
      [Symbol.asyncDispose]: () => stack.disposeAsync(),
    };
  } catch (error) {
    if (logPath) console.error((await readFile(logPath, "utf8")).split("\n").slice(-40).join("\n"));
    await stack.disposeAsync(); throw error;
  }
}
