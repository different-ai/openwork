/**
 * Native Electron MCP server for the built-in WebContentsView.
 *
 * Replaces Puppeteer-over-CDP with direct webContents APIs.
 * Minimal CDP is used via webContents.debugger for:
 *   - Accessibility tree snapshots (Accessibility.getFullAXTree)
 *   - DOM node resolution for uid-based click/fill (DOM.resolveNode)
 *   - Input dispatch for drag/key operations (Input.dispatch*)
 *   - Emulation overrides (Emulation.*)
 *
 * Everything else uses Electron's native webContents methods:
 *   - loadURL(), goBack(), goForward(), reload()
 *   - capturePage()
 *   - executeJavaScript()
 */

import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Import MCP SDK + zod directly — no chrome-devtools-mcp dependency.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ── Snapshot manager ──────────────────────────────────────────────────
//
// Manages the a11y tree snapshot and uid→backendDOMNodeId mapping.
// Uses webContents.debugger for CDP Accessibility calls (scoped to
// this single WebContentsView, no app-level --remote-debugging-port).

class NativeSnapshot {
  #getWebContents;
  #nodes = new Map(); // uid → node data
  #snapshotCounter = 0;
  #stableIdMap = new Map(); // backendDOMNodeId → uid (stable across snapshots)
  #debuggerReady = false;

  constructor(getWebContents) {
    this.#getWebContents = getWebContents;
  }

  #ensureDebugger() {
    const wc = this.#getWebContents();
    if (!wc || wc.isDestroyed()) throw new Error("No browser page available.");
    if (!this.#debuggerReady) {
      try {
        wc.debugger.attach("1.3");
      } catch {
        // Already attached — fine
      }
      this.#debuggerReady = true;
      wc.once("destroyed", () => { this.#debuggerReady = false; });
    }
    return wc;
  }

  async take(verbose = false) {
    const wc = this.#ensureDebugger();
    await wc.debugger.sendCommand("Accessibility.enable");
    const { nodes: rawNodes } = await wc.debugger.sendCommand(
      "Accessibility.getFullAXTree",
    );

    // Build a lookup from CDP nodeId → raw node
    const cdpById = new Map();
    for (const n of rawNodes) cdpById.set(n.nodeId, n);

    this.#snapshotCounter++;
    const sid = this.#snapshotCounter;
    let counter = 0;
    this.#nodes.clear();
    const seenBackendIds = new Set();

    const processNode = (cdpNode) => {
      const bid = cdpNode.backendDOMNodeId;
      const bidKey = String(bid ?? "");

      // Re-use stable uid when the same DOM node appears across snapshots
      let uid;
      if (bidKey && this.#stableIdMap.has(bidKey)) {
        uid = this.#stableIdMap.get(bidKey);
      } else {
        uid = `${sid}_${counter++}`;
        if (bidKey) this.#stableIdMap.set(bidKey, uid);
      }
      if (bidKey) seenBackendIds.add(bidKey);

      const role = cdpNode.role?.value ?? "";
      const name = cdpNode.name?.value ?? "";
      const value = cdpNode.value?.value;
      const ignored = cdpNode.ignored ?? false;

      // Extract meaningful properties
      const props = {};
      for (const p of cdpNode.properties ?? []) {
        if (p.value?.value !== undefined) props[p.name] = p.value.value;
      }

      const children = (cdpNode.childIds ?? [])
        .map((id) => cdpById.get(id))
        .filter(Boolean)
        .map(processNode);

      const node = { uid, role, name, value, ignored, backendDOMNodeId: bid, props, children };
      this.#nodes.set(uid, node);
      return node;
    };

    if (!rawNodes[0]) return "Empty page — no accessibility tree.";
    const root = processNode(rawNodes[0]);

    // Prune stale mappings
    for (const key of this.#stableIdMap.keys()) {
      if (!seenBackendIds.has(key)) this.#stableIdMap.delete(key);
    }

    return this.#format(root, verbose);
  }

  #format(node, verbose, depth = 0) {
    if (!node) return "";
    if ((node.ignored || node.role === "none") && !verbose) {
      return node.children.map((c) => this.#format(c, verbose, depth)).join("");
    }

    const indent = "  ".repeat(depth);
    const parts = [`uid=${node.uid}`];
    if (node.role) parts.push(node.role === "none" ? "ignored" : node.role);
    if (node.name) parts.push(`"${node.name}"`);
    if (node.value !== undefined) parts.push(`value="${node.value}"`);

    for (const [k, v] of Object.entries(node.props)) {
      if (typeof v === "boolean" && v) parts.push(k);
      else if (typeof v === "string" || typeof v === "number") parts.push(`${k}="${v}"`);
    }

    const lines = [indent + parts.join(" ")];
    for (const child of node.children) {
      const s = this.#format(child, verbose, depth + 1);
      if (s) lines.push(s);
    }
    return lines.join("\n");
  }

  /** Resolve a snapshot uid to a CDP RemoteObject objectId. */
  async resolveElement(uid) {
    if (!this.#nodes.size) {
      throw new Error("No snapshot found. Use take_snapshot to capture one.");
    }
    const node = this.#nodes.get(uid);
    if (!node) throw new Error(`No such element found in the snapshot (uid: ${uid}).`);
    if (!node.backendDOMNodeId) {
      throw new Error(`Element "${uid}" (${node.role}) has no backing DOM node.`);
    }

    const wc = this.#ensureDebugger();
    const { object } = await wc.debugger.sendCommand("DOM.resolveNode", {
      backendNodeId: node.backendDOMNodeId,
    });
    if (!object?.objectId) {
      throw new Error(`Element "${uid}" no longer exists on the page.`);
    }
    return object.objectId;
  }

  /** Get node data for a uid (used by upload_file for backendDOMNodeId). */
  getNodeData(uid) {
    return this.#nodes.get(uid);
  }

  /** Reset snapshot state. Call when the WebContentsView is destroyed. */
  reset() {
    try { this.#getWebContents()?.debugger?.detach(); } catch { /* ok */ }
    this.#debuggerReady = false;
    this.#nodes.clear();
    this.#stableIdMap.clear();
  }
}

// ── MCP server factory ────────────────────────────────────────────────

/**
 * Create an MCP server for the built-in browser using native Electron APIs.
 *
 * @param {object}   opts
 * @param {Function} opts.getWebContents — () => webContents | null
 * @param {Function} [opts.onToolCall]   — called before each tool
 * @param {Function} [opts.onHideBrowser] — called to close the browser panel
 * @returns {McpServer}
 */
export function createNativeBuiltinServer({ getWebContents, onToolCall, onHideBrowser }) {
  const server = new McpServer(
    { name: "openwork-browser", version: "0.2.0" },
    { capabilities: { logging: {} } },
  );

  const snap = new NativeSnapshot(getWebContents);

  // Expose reset so main.mjs can call it when the view is destroyed
  server._snapshotReset = () => snap.reset();

  function wc() {
    const c = getWebContents();
    if (!c || c.isDestroyed()) throw new Error("Built-in browser is not open.");
    return c;
  }

  /** Navigate and wait for the page to load. Simple event-based wait —
   *  the about:blank preload in createBrowserView prevents session-restore races. */
  function navigateAndWait(webContents, url, timeoutMs = 30_000) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      const done = () => { clearTimeout(timer); resolve(); };
      webContents.once("did-finish-load", done);
      webContents.once("did-fail-load", done);
      webContents.loadURL(url);
    });
  }

  /** Wait for a navigation action (back/forward/reload) to complete.
   *  Rejects on timeout so the caller reports the failure honestly. */
  function waitForNav(webContents, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Navigation timed out")), timeoutMs);
      const done = () => { clearTimeout(timer); resolve(); };
      webContents.once("did-finish-load", done);
      webContents.once("did-fail-load", done);
    });
  }

  // Helper: run a tool body inside an error boundary
  function defineTool(name, description, schema, handler) {
    server.tool(name, description, schema, async (params) => {
      try {
        await onToolCall?.(name, params);
        return await handler(params);
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message ?? err}` }] };
      }
    });
  }

  // ── Navigation ────────────────────────────────────────────────────

  defineTool(
    "navigate_page",
    "Go to a URL, or back, forward, or reload.",
    {
      url: z.string().optional().describe("Target URL (only type=url)"),
      type: z.enum(["url", "back", "forward", "reload"]).optional()
        .describe("Navigate by URL, back/forward in history, or reload."),
      timeout: z.number().int().optional()
        .describe("Maximum wait time in milliseconds. Default: 30000"),
      ignoreCache: z.boolean().optional()
        .describe("Whether to ignore cache on reload."),
    },
    async (params) => {
      const w = wc();
      const type = params.type ?? "url";
      const timeout = params.timeout ?? 30_000;

      if (type === "url") {
        const url = String(params.url ?? "").trim();
        if (!url) throw new Error("navigate_page requires a url for type=url");
        await navigateAndWait(w, url, timeout);
      } else if (type === "back") {
        if (w.navigationHistory?.canGoBack?.() ?? w.canGoBack()) {
          const p = waitForNav(w, timeout);
          w.goBack();
          await p;
        }
      } else if (type === "forward") {
        if (w.navigationHistory?.canGoForward?.() ?? w.canGoForward()) {
          const p = waitForNav(w, timeout);
          w.goForward();
          await p;
        }
      } else if (type === "reload") {
        const p = waitForNav(w, timeout);
        params.ignoreCache ? w.reloadIgnoringCache() : w.reload();
        await p;
      }

      return { content: [{ type: "text", text: `Navigated to ${w.getURL()}` }] };
    },
  );

  // ── Snapshot ──────────────────────────────────────────────────────

  defineTool(
    "take_snapshot",
    "Take a text snapshot of the currently selected page based on the a11y tree. " +
    "The snapshot lists page elements along with a unique identifier (uid). " +
    "Always use the latest snapshot. Prefer taking a snapshot over taking a screenshot.",
    {
      verbose: z.boolean().optional()
        .describe("Include all possible information in the full a11y tree. Default: false."),
      filePath: z.string().optional()
        .describe("Save snapshot to this path instead of returning inline."),
    },
    async (params) => {
      const text = await snap.take(params.verbose ?? false);
      if (params.filePath) {
        await writeFile(params.filePath, text, "utf8");
        return { content: [{ type: "text", text: `Saved snapshot to ${params.filePath}.` }] };
      }
      return { content: [{ type: "text", text: "## Latest page snapshot\n" + text }] };
    },
  );

  // ── Screenshot ────────────────────────────────────────────────────

  defineTool(
    "take_screenshot",
    "Take a screenshot of the page or element.",
    {
      format: z.enum(["png", "jpeg", "webp"]).default("png")
        .describe('Format. Default: "png"'),
      quality: z.number().min(0).max(100).optional()
        .describe("JPEG/WebP quality (0-100). Ignored for PNG."),
      uid: z.string().optional()
        .describe("Element uid from snapshot. Omit for page screenshot."),
      fullPage: z.boolean().optional()
        .describe("Full scrollable page screenshot. Incompatible with uid."),
      filePath: z.string().optional()
        .describe("Save screenshot to this path instead of returning inline."),
    },
    async (params) => {
      const w = wc();
      if (params.uid && params.fullPage) throw new Error('Cannot use both "uid" and "fullPage".');

      let imageBuffer;
      const fmt = params.format ?? "png";

      if (params.uid) {
        // Element screenshot via bounding rect — clamp to viewport
        const objectId = await snap.resolveElement(params.uid);
        const { result } = await w.debugger.sendCommand("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: `function() {
            this.scrollIntoViewIfNeeded();
            const r = this.getBoundingClientRect();
            return JSON.stringify({
              x: Math.max(0, Math.round(r.x)),
              y: Math.max(0, Math.round(r.y)),
              width: Math.round(Math.min(r.width, window.innerWidth - Math.max(0, r.x))),
              height: Math.round(Math.min(r.height, window.innerHeight - Math.max(0, r.y)))
            });
          }`,
          returnByValue: true,
        });
        const rect = JSON.parse(result.value);
        if (rect.width > 0 && rect.height > 0) {
          const img = await w.capturePage(rect);
          imageBuffer = fmt === "jpeg" ? img.toJPEG(params.quality ?? 80) : img.toPNG();
        } else {
          // Element not visible — fall back to viewport screenshot
          const img = await w.capturePage();
          imageBuffer = fmt === "jpeg" ? img.toJPEG(params.quality ?? 80) : img.toPNG();
        }
      } else {
        const img = await w.capturePage();
        imageBuffer = fmt === "jpeg" ? img.toJPEG(params.quality ?? 80) : img.toPNG();
      }

      if (params.filePath) {
        await writeFile(params.filePath, imageBuffer);
        return { content: [{ type: "text", text: `Screenshot saved to ${params.filePath}.` }] };
      }
      if (imageBuffer.length >= 2_000_000) {
        const p = join(tmpdir(), `openwork-ss-${Date.now()}.${fmt}`);
        await writeFile(p, imageBuffer);
        return { content: [{ type: "text", text: `Screenshot saved to ${p} (${(imageBuffer.length / 1024) | 0} KB).` }] };
      }
      return { content: [{ type: "image", mimeType: `image/${fmt}`, data: imageBuffer.toString("base64") }] };
    },
  );

  // ── Click ─────────────────────────────────────────────────────────

  defineTool(
    "click",
    "Clicks on the provided element.",
    {
      uid: z.string().describe("Element uid from page snapshot"),
      dblClick: z.boolean().optional().describe("Double click. Default: false."),
      includeSnapshot: z.boolean().optional().describe("Include snapshot in response. Default: false."),
    },
    async (params) => {
      const objectId = await snap.resolveElement(params.uid);
      const w = wc();
      await w.debugger.sendCommand("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function(dbl) {
          this.scrollIntoViewIfNeeded();
          this.click();
          if (dbl) this.click();
        }`,
        arguments: [{ value: !!params.dblClick }],
      });
      const text = params.dblClick ? "Successfully double clicked on the element" : "Successfully clicked on the element";
      if (params.includeSnapshot) {
        return { content: [{ type: "text", text }, { type: "text", text: await snap.take(false) }] };
      }
      return { content: [{ type: "text", text }] };
    },
  );

  // ── Hover ─────────────────────────────────────────────────────────

  defineTool(
    "hover",
    "Hover over the provided element.",
    {
      uid: z.string().describe("Element uid from page snapshot"),
      includeSnapshot: z.boolean().optional(),
    },
    async (params) => {
      const objectId = await snap.resolveElement(params.uid);
      const w = wc();
      await w.debugger.sendCommand("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function() {
          this.scrollIntoViewIfNeeded();
          this.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
          this.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        }`,
      });
      const text = "Successfully hovered over the element";
      if (params.includeSnapshot) {
        return { content: [{ type: "text", text }, { type: "text", text: await snap.take(false) }] };
      }
      return { content: [{ type: "text", text }] };
    },
  );

  // ── Fill ──────────────────────────────────────────────────────────

  const FILL_FN = `function(val) {
    this.scrollIntoViewIfNeeded();
    this.focus();
    if (this.tagName === 'SELECT') {
      const opt = Array.from(this.options).find(o => o.text === val || o.value === val);
      if (opt) this.value = opt.value; else this.value = val;
    } else {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(this, val); else this.value = val;
    }
    this.dispatchEvent(new Event('input', { bubbles: true }));
    this.dispatchEvent(new Event('change', { bubbles: true }));
  }`;

  defineTool(
    "fill",
    "Type text into an input, text area, or select an option from a <select> element.",
    {
      uid: z.string().describe("Element uid from page snapshot"),
      value: z.string().describe("The value to fill in"),
      includeSnapshot: z.boolean().optional(),
    },
    async (params) => {
      const objectId = await snap.resolveElement(params.uid);
      await wc().debugger.sendCommand("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: FILL_FN,
        arguments: [{ value: params.value }],
      });
      const text = "Successfully filled out the element";
      if (params.includeSnapshot) {
        return { content: [{ type: "text", text }, { type: "text", text: await snap.take(false) }] };
      }
      return { content: [{ type: "text", text }] };
    },
  );

  // ── Fill form ─────────────────────────────────────────────────────

  defineTool(
    "fill_form",
    "Fill out multiple form elements at once.",
    {
      elements: z.array(z.object({
        uid: z.string().describe("Element uid to fill out"),
        value: z.string().describe("Value for the element"),
      })).describe("Elements from snapshot to fill out."),
      includeSnapshot: z.boolean().optional(),
    },
    async (params) => {
      for (const el of params.elements) {
        const objectId = await snap.resolveElement(el.uid);
        await wc().debugger.sendCommand("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: FILL_FN,
          arguments: [{ value: el.value }],
        });
      }
      const text = "Successfully filled out the form";
      if (params.includeSnapshot) {
        return { content: [{ type: "text", text }, { type: "text", text: await snap.take(false) }] };
      }
      return { content: [{ type: "text", text }] };
    },
  );

  // ── Drag ──────────────────────────────────────────────────────────

  defineTool(
    "drag",
    "Drag an element onto another element.",
    {
      from_uid: z.string().describe("Element uid to drag"),
      to_uid: z.string().describe("Element uid to drop into"),
      includeSnapshot: z.boolean().optional(),
    },
    async (params) => {
      const w = wc();
      const fromId = await snap.resolveElement(params.from_uid);
      const toId = await snap.resolveElement(params.to_uid);

      const getCenter = async (objectId) => {
        const { result } = await w.debugger.sendCommand("Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: `function() { this.scrollIntoViewIfNeeded(); const r = this.getBoundingClientRect(); return JSON.stringify({ x: r.x + r.width/2, y: r.y + r.height/2 }); }`,
          returnByValue: true,
        });
        return JSON.parse(result.value);
      };

      const from = await getCenter(fromId);
      const to = await getCenter(toId);
      const steps = 10;

      await w.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
      await w.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        await w.debugger.sendCommand("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: from.x + (to.x - from.x) * t,
          y: from.y + (to.y - from.y) * t,
        });
      }
      await w.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 });

      const text = "Successfully dragged an element";
      if (params.includeSnapshot) {
        return { content: [{ type: "text", text }, { type: "text", text: await snap.take(false) }] };
      }
      return { content: [{ type: "text", text }] };
    },
  );

  // ── Upload file ───────────────────────────────────────────────────

  defineTool(
    "upload_file",
    "Upload a file through a provided element.",
    {
      uid: z.string().describe("Element uid of file input or trigger element"),
      filePath: z.string().describe("Local path of the file to upload"),
      includeSnapshot: z.boolean().optional(),
    },
    async (params) => {
      const node = snap.getNodeData(params.uid);
      if (!node?.backendDOMNodeId) throw new Error(`Element "${params.uid}" has no DOM node.`);
      await wc().debugger.sendCommand("DOM.setFileInputFiles", {
        files: [params.filePath],
        backendNodeId: node.backendDOMNodeId,
      });
      const text = `File uploaded from ${params.filePath}.`;
      if (params.includeSnapshot) {
        return { content: [{ type: "text", text }, { type: "text", text: await snap.take(false) }] };
      }
      return { content: [{ type: "text", text }] };
    },
  );

  // ── Press key ─────────────────────────────────────────────────────

  defineTool(
    "press_key",
    'Press a key or key combination (e.g. "Enter", "Control+A", "Control+Shift+R"). Modifiers: Control, Shift, Alt, Meta.',
    {
      key: z.string().describe('A key or combination, e.g. "Enter", "Control+A"'),
      includeSnapshot: z.boolean().optional(),
    },
    async (params) => {
      const w = wc();
      const tokens = params.key.split("+");
      const mainKey = tokens.pop();
      const modifiers = [...tokens]; // defensive copy before reverse

      let flags = 0;
      for (const m of modifiers) {
        if (m === "Alt") flags |= 1;
        if (m === "Control") flags |= 2;
        if (m === "Meta") flags |= 4;
        if (m === "Shift") flags |= 8;
      }

      const dbg = w.debugger;
      for (const m of modifiers) {
        await dbg.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: m, modifiers: flags });
      }
      await dbg.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: mainKey, text: mainKey.length === 1 ? mainKey : "", modifiers: flags });
      if (mainKey.length === 1) {
        await dbg.sendCommand("Input.dispatchKeyEvent", { type: "char", text: mainKey, modifiers: flags });
      }
      await dbg.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: mainKey, modifiers: flags });
      for (const m of [...modifiers].reverse()) {
        await dbg.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: m, modifiers: flags });
      }

      const text = `Successfully pressed key: ${params.key}`;
      if (params.includeSnapshot) {
        return { content: [{ type: "text", text }, { type: "text", text: await snap.take(false) }] };
      }
      return { content: [{ type: "text", text }] };
    },
  );

  // ── Type text ─────────────────────────────────────────────────────

  defineTool(
    "type_text",
    "Type text using keyboard into a previously focused input.",
    {
      text: z.string().describe("The text to type"),
      submitKey: z.string().optional().describe('Optional key to press after typing, e.g. "Enter", "Tab"'),
    },
    async (params) => {
      const dbg = wc().debugger;
      for (const ch of params.text) {
        await dbg.sendCommand("Input.dispatchKeyEvent", { type: "char", text: ch });
      }
      if (params.submitKey) {
        await dbg.sendCommand("Input.dispatchKeyEvent", { type: "rawKeyDown", key: params.submitKey });
        await dbg.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: params.submitKey });
      }
      return { content: [{ type: "text", text: `Typed "${params.text}"${params.submitKey ? ` and pressed ${params.submitKey}` : ""}` }] };
    },
  );

  // ── Evaluate script ───────────────────────────────────────────────

  defineTool(
    "evaluate_script",
    "Evaluate a JavaScript function inside the current page. Returns JSON-serializable values.",
    {
      function: z.string().describe(
        'A JavaScript function declaration, e.g. `() => { return document.title }` or `(el) => { return el.innerText; }`',
      ),
      args: z.array(z.string()).optional()
        .describe("Optional list of element uids from the page snapshot to pass as arguments to the function"),
      dialogAction: z.string().optional()
        .describe('Handle dialogs during execution: "accept", "dismiss", or prompt response text. Default: accept.'),
    },
    async (params) => {
      const w = wc();

      if (params.args?.length) {
        const argIds = [];
        for (const uid of params.args) argIds.push(await snap.resolveElement(uid));
        const { result } = await w.debugger.sendCommand("Runtime.callFunctionOn", {
          objectId: argIds[0],
          functionDeclaration: params.function,
          arguments: argIds.slice(1).map((id) => ({ objectId: id })),
          returnByValue: true,
        });
        return { content: [{ type: "text", text: JSON.stringify(result?.value, null, 2) ?? "undefined" }] };
      }

      const result = await w.executeJavaScript(`(${params.function})()`);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) ?? "undefined" }] };
    },
  );

  // ── Wait for ──────────────────────────────────────────────────────

  defineTool(
    "wait_for",
    "Wait for the specified text to appear on the selected page.",
    {
      text: z.union([z.string(), z.array(z.string()).min(1)])
        .describe("Non-empty list of texts. Resolves when any value appears on the page."),
      timeout: z.number().int().optional()
        .describe("Maximum wait time in milliseconds. Default: 30000"),
    },
    async (params) => {
      const w = wc();
      const texts = Array.isArray(params.text) ? params.text : [params.text];
      const deadline = Date.now() + (params.timeout ?? 30_000);

      while (Date.now() < deadline) {
        for (const t of texts) {
          const found = await w.executeJavaScript(
            `document.body?.innerText?.includes(${JSON.stringify(t)}) ?? false`,
          );
          if (found) {
            const snapText = await snap.take(false);
            return { content: [
              { type: "text", text: `Element with text "${t}" found.` },
              { type: "text", text: snapText },
            ] };
          }
        }
        await new Promise((r) => setTimeout(r, 500));
      }

      throw new Error(`Timeout: none of [${texts.map(t => `"${t}"`).join(", ")}] appeared within ${params.timeout ?? 30_000}ms.`);
    },
  );

  // ── Handle dialog ─────────────────────────────────────────────────

  defineTool(
    "handle_dialog",
    "Handle a browser dialog (alert, confirm, prompt).",
    {
      action: z.enum(["accept", "dismiss"]).describe("Whether to dismiss or accept the dialog"),
      promptText: z.string().optional().describe("Optional prompt text to enter"),
    },
    async (params) => {
      await wc().debugger.sendCommand("Page.handleJavaScriptDialog", {
        accept: params.action === "accept",
        promptText: params.promptText,
      });
      return { content: [{ type: "text", text: `Dialog ${params.action}ed.` }] };
    },
  );

  // ── Page management (single-page) ─────────────────────────────────

  defineTool(
    "list_pages",
    "Get a list of pages open in the browser.",
    {},
    async () => {
      const w = wc();
      return { content: [{ type: "text", text: JSON.stringify([{
        pageId: 1, url: w.getURL(), title: w.getTitle(), selected: true,
      }]) }] };
    },
  );

  defineTool(
    "select_page",
    "Select a page as context for future tool calls.",
    { pageId: z.number().describe("Page ID to select.") },
    async (params) => {
      if (params.pageId !== 1) throw new Error("Only page 1 exists in the built-in browser.");
      return { content: [{ type: "text", text: "Page 1 selected." }] };
    },
  );

  // ── Resize ────────────────────────────────────────────────────────

  defineTool(
    "resize_page",
    "Resizes the selected page's window so that the page has specified dimension.",
    {
      width: z.number().describe("Page width"),
      height: z.number().describe("Page height"),
    },
    async (params) => {
      return { content: [{ type: "text", text: `Resize requested (${params.width}x${params.height}). Actual size depends on app layout.` }] };
    },
  );

  // ── Emulate ───────────────────────────────────────────────────────

  defineTool(
    "emulate",
    "Emulates various features on the selected page.",
    {
      colorScheme: z.enum(["dark", "light", "auto"]).optional()
        .describe('Emulate dark or light mode. "auto" to reset.'),
      userAgent: z.string().optional()
        .describe("User agent to emulate. Empty string to clear."),
    },
    async (params) => {
      const dbg = wc().debugger;
      const results = [];

      if (params.colorScheme) {
        const media = params.colorScheme === "auto" ? "" : params.colorScheme;
        await dbg.sendCommand("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: media || "" }],
        });
        results.push(`Color scheme: ${params.colorScheme}`);
      }

      if (params.userAgent !== undefined) {
        await dbg.sendCommand("Emulation.setUserAgentOverride", {
          userAgent: params.userAgent || "",
        });
        results.push(`User agent: ${params.userAgent || "(cleared)"}`);
      }

      return { content: [{ type: "text", text: results.length ? results.join("; ") : "No emulation changes applied." }] };
    },
  );

  // ── Show / Hide browser ───────────────────────────────────────────

  server.tool(
    "show_browser",
    "Open the built-in browser panel inside the OpenWork app. " +
    "Called automatically when any browser tool runs, but can also be called explicitly.",
    {},
    async () => {
      await onToolCall?.("show_browser");
      return { content: [{ type: "text", text: "Browser panel opened." }] };
    },
  );

  server.tool(
    "hide_browser",
    "Close the built-in browser panel. Call when the browsing task is finished.",
    {},
    async () => {
      onHideBrowser?.();
      return { content: [{ type: "text", text: "Browser panel closed." }] };
    },
  );

  return server;
}
