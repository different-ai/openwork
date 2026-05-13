/**
 * Browser control tools — direct CDP, no MCP, multi-target.
 *
 * Every tool takes a `browser_url` (e.g. "http://127.0.0.1:9825")
 * and optionally a `target_id`. No hidden state, no singleton browser.
 *
 * Usage in opencode:
 *   browser_list     — list all page targets on a browser
 *   browser_navigate — navigate a target to a URL
 *   browser_snapshot — get accessibility tree with UIDs
 *   browser_click    — click an element by snapshot UID
 *   browser_fill     — fill an input by snapshot UID
 *   browser_eval     — evaluate JS in the page
 *   browser_screenshot — take a PNG screenshot
 */

import { tool } from "@opencode-ai/plugin";
import { listTargets, connectTarget, connectFirstPage } from "./lib/cdp";
import { takeSnapshot, resolveUid, type Snapshot } from "./lib/snapshot";

// Cache the last snapshot per target so click/fill can resolve UIDs
const snapshotCache = new Map<string, Snapshot>();

function cacheKey(browserUrl: string, targetId?: string): string {
  return `${browserUrl}::${targetId ?? "default"}`;
}

async function getClient(browserUrl: string, targetId?: string) {
  if (targetId) {
    const targets = await listTargets(browserUrl);
    const target = targets.find((t) => t.id === targetId);
    if (!target) throw new Error(`Target ${targetId} not found`);
    return { client: await connectTarget(target.webSocketDebuggerUrl), target };
  }
  return connectFirstPage(browserUrl);
}

// ── browser_list ──

export const list = tool({
  description:
    "List all page targets (tabs/windows) on a Chrome/Electron instance. " +
    "Returns target IDs, titles, and URLs. Use browser_url to specify which browser.",
  args: {
    browser_url: tool.schema
      .string()
      .describe('CDP HTTP endpoint, e.g. "http://127.0.0.1:9825"'),
  },
  async execute(args) {
    const targets = await listTargets(args.browser_url);
    const pages = targets.filter((t) => t.type === "page");
    if (pages.length === 0) return "No page targets found.";
    return pages
      .map((t) => `[${t.id}] ${t.title}\n  ${t.url}`)
      .join("\n\n");
  },
});

// ── browser_navigate ──

export const navigate = tool({
  description:
    "Navigate a browser target to a URL. Returns the new page title after navigation.",
  args: {
    browser_url: tool.schema.string().describe("CDP HTTP endpoint"),
    target_id: tool.schema.string().optional().describe("Target ID (omit for first page)"),
    url: tool.schema.string().describe("URL to navigate to"),
  },
  async execute(args) {
    const { client, target } = await getClient(args.browser_url, args.target_id);
    try {
      await client.send("Page.enable");
      await client.send("Page.navigate", { url: args.url });
      // Wait for load
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 10000);
        client.on("Page.loadEventFired", () => { clearTimeout(timeout); resolve(); });
      });
      const result = await client.send("Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      });
      const title = (result.result as Record<string, unknown>)?.value as string ?? "";
      return `Navigated to: ${args.url}\nTitle: ${title}`;
    } finally {
      client.close();
    }
  },
});

// ── browser_snapshot ──

export const snapshot = tool({
  description:
    "Get an accessibility tree snapshot of the page. Returns a text tree with [uid] markers. " +
    "Use these UIDs with browser_click and browser_fill.",
  args: {
    browser_url: tool.schema.string().describe("CDP HTTP endpoint"),
    target_id: tool.schema.string().optional().describe("Target ID (omit for first page)"),
  },
  async execute(args) {
    const { client, target } = await getClient(args.browser_url, args.target_id);
    try {
      await client.send("Accessibility.enable");
      const snap = await takeSnapshot(client);
      snapshotCache.set(cacheKey(args.browser_url, args.target_id), snap);
      if (!snap.text || snap.text === "(empty page)") {
        // Fallback: return page text content
        const result = await client.send("Runtime.evaluate", {
          expression: "document.body?.innerText?.substring(0, 3000) ?? '(empty)'",
          returnByValue: true,
        });
        return `Page text:\n${(result.result as Record<string, unknown>)?.value ?? "(empty)"}`;
      }
      return snap.text;
    } finally {
      client.close();
    }
  },
});

// ── browser_click ──

export const click = tool({
  description:
    "Click an element on the page identified by its snapshot UID. " +
    "Take a browser_snapshot first to get UIDs.",
  args: {
    browser_url: tool.schema.string().describe("CDP HTTP endpoint"),
    target_id: tool.schema.string().optional().describe("Target ID"),
    uid: tool.schema.number().describe("Element UID from the snapshot"),
  },
  async execute(args) {
    const snap = snapshotCache.get(cacheKey(args.browser_url, args.target_id));
    if (!snap) return "No snapshot cached. Call browser_snapshot first.";
    const node = resolveUid(snap, args.uid);
    if (!node) return `UID ${args.uid} not found in snapshot.`;

    const { client } = await getClient(args.browser_url, args.target_id);
    try {
      // Resolve the backend node to a remote object
      const resolved = await client.send("DOM.resolveNode", {
        backendNodeId: node.backendNodeId,
      });
      const objectId = (resolved.object as Record<string, unknown>)?.objectId as string;
      if (!objectId) return `Could not resolve UID ${args.uid} to a DOM node.`;

      // Get the bounding box
      const box = await client.send("DOM.getBoxModel", {
        backendNodeId: node.backendNodeId,
      });
      const model = box.model as Record<string, unknown> | undefined;
      const content = model?.content as number[] | undefined;

      if (content && content.length >= 4) {
        // Click the center of the element
        const x = (content[0] + content[2] + content[4] + content[6]) / 4;
        const y = (content[1] + content[3] + content[5] + content[7]) / 4;
        await client.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
        await client.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
        return `Clicked [${args.uid}] "${node.name}" at (${Math.round(x)}, ${Math.round(y)})`;
      }

      // Fallback: focus + click via JS
      await client.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function() { this.scrollIntoView({block:'center'}); this.click(); }",
      });
      return `Clicked [${args.uid}] "${node.name}" via JS fallback`;
    } finally {
      client.close();
    }
  },
});

// ── browser_fill ──

export const fill = tool({
  description:
    "Fill an input element identified by its snapshot UID with text. " +
    "Clears existing value first.",
  args: {
    browser_url: tool.schema.string().describe("CDP HTTP endpoint"),
    target_id: tool.schema.string().optional().describe("Target ID"),
    uid: tool.schema.number().describe("Element UID from the snapshot"),
    value: tool.schema.string().describe("Text to fill"),
  },
  async execute(args) {
    const snap = snapshotCache.get(cacheKey(args.browser_url, args.target_id));
    if (!snap) return "No snapshot cached. Call browser_snapshot first.";
    const node = resolveUid(snap, args.uid);
    if (!node) return `UID ${args.uid} not found in snapshot.`;

    const { client } = await getClient(args.browser_url, args.target_id);
    try {
      const resolved = await client.send("DOM.resolveNode", {
        backendNodeId: node.backendNodeId,
      });
      const objectId = (resolved.object as Record<string, unknown>)?.objectId as string;
      if (!objectId) return `Could not resolve UID ${args.uid}.`;

      // Focus, clear, then type
      await client.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function() {
          this.focus();
          this.value = '';
          this.dispatchEvent(new Event('input', { bubbles: true }));
        }`,
      });

      // Type character by character for React compatibility
      for (const char of args.value) {
        await client.send("Input.dispatchKeyEvent", { type: "keyDown", text: char });
        await client.send("Input.dispatchKeyEvent", { type: "keyUp", text: char });
      }

      return `Filled [${args.uid}] "${node.name}" with "${args.value}"`;
    } finally {
      client.close();
    }
  },
});

// ── browser_eval ──

export const evaluate = tool({
  description:
    "Evaluate a JavaScript expression in the page and return the result.",
  args: {
    browser_url: tool.schema.string().describe("CDP HTTP endpoint"),
    target_id: tool.schema.string().optional().describe("Target ID"),
    expression: tool.schema.string().describe("JavaScript expression to evaluate"),
  },
  async execute(args) {
    const { client } = await getClient(args.browser_url, args.target_id);
    try {
      const result = await client.send("Runtime.evaluate", {
        expression: args.expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        const err = result.exceptionDetails as Record<string, unknown>;
        return `Error: ${err.text ?? JSON.stringify(err)}`;
      }
      const val = (result.result as Record<string, unknown>)?.value;
      if (val === undefined) return "(undefined)";
      return typeof val === "string" ? val : JSON.stringify(val, null, 2);
    } finally {
      client.close();
    }
  },
});

// ── browser_screenshot ──

export const screenshot = tool({
  description:
    "Take a PNG screenshot of the page. Returns the base64-encoded image data.",
  args: {
    browser_url: tool.schema.string().describe("CDP HTTP endpoint"),
    target_id: tool.schema.string().optional().describe("Target ID"),
  },
  async execute(args) {
    const { client } = await getClient(args.browser_url, args.target_id);
    try {
      const result = await client.send("Page.captureScreenshot", { format: "png" });
      const data = result.data as string;
      if (!data) return "Failed to capture screenshot.";
      // Write to temp file and return path
      const path = `/tmp/browser-screenshot-${Date.now()}.png`;
      const fs = await import("fs");
      fs.writeFileSync(path, Buffer.from(data, "base64"));
      return `Screenshot saved: ${path}\n(${Math.round(data.length * 0.75 / 1024)} KB)`;
    } finally {
      client.close();
    }
  },
});
