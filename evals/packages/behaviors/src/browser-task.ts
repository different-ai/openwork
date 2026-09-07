import { connect, debuggerUrlFor, evaluate, evaluateOnSurface, listTargets } from "@openwork/cdp";
import type { Surface } from "@openwork/cdp";

export interface BrowserTaskInput {
  sessionId: string;
  operation: "tabs" | "open" | "navigate" | "observe" | "act" | "site_tools" | "site_tool" | "pause" | "handoff";
  args?: {
    tabId?: string;
    url?: string;
    provider?: string;
    includeImage?: boolean;
    observationId?: string;
    toolId?: string;
    input?: unknown;
    action?: { type: "click" | "fill" | "key" | "scroll"; ref?: string; text?: string; key?: string; x?: number; y?: number; deltaY?: number };
  };
}

export interface BrowserTaskReply {
  [key: string]: unknown;
  ok: boolean;
  visible?: boolean;
  code?: string;
  tabId?: string;
  observationId?: string;
  text?: string;
  url?: string;
  dispatched?: boolean;
  mayHaveChangedState?: boolean;
  outcome?: string;
  trust?: string;
  image?: { data: string };
  tools?: Array<{ toolId: string; name: string; origin: string }>;
  elements?: Array<{ ref: string; name: string }>;
  result?: unknown;
}

export interface BrowserState {
  activeTabId: string | null;
  visibleSessionId: string | null;
  tabs: Array<{ id: string; label: string; ownerSessionId: string | null }>;
  nativeViews: Array<{ tabId: string; attached: boolean; aboveApp: boolean; visible: boolean; bounds: { x: number; y: number; width: number; height: number } }>;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a browser string.");
  return value;
}

export function parseBrowserTaskReply(value: unknown): BrowserTaskReply {
  if (!record(value) || typeof value.ok !== "boolean") throw new Error("The browser returned no result.");
  return {
    // Retain unknown fields so disclosure assertions cannot hide a leaked payload.
    ...value,
    ok: value.ok,
    ...(typeof value.visible === "boolean" ? { visible: value.visible } : {}),
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.tabId === "string" ? { tabId: value.tabId } : {}),
    ...(typeof value.observationId === "string" ? { observationId: value.observationId } : {}),
    ...(typeof value.text === "string" ? { text: value.text } : {}),
    ...(typeof value.url === "string" ? { url: value.url } : {}),
    ...(typeof value.dispatched === "boolean" ? { dispatched: value.dispatched } : {}),
    ...(typeof value.mayHaveChangedState === "boolean" ? { mayHaveChangedState: value.mayHaveChangedState } : {}),
    ...(typeof value.outcome === "string" ? { outcome: value.outcome } : {}),
    ...(typeof value.trust === "string" ? { trust: value.trust } : {}),
    ...(record(value.image) ? { image: { data: string(value.image.data) } } : {}),
    ...(Array.isArray(value.tools) ? { tools: value.tools.map((tool: unknown) => {
      if (!record(tool)) throw new Error("Invalid website tool.");
      return { toolId: string(tool.toolId), name: string(tool.name), origin: string(tool.origin) };
    }) } : {}),
    ...(Array.isArray(value.elements) ? { elements: value.elements.map((element: unknown) => {
      if (!record(element)) throw new Error("Invalid page control.");
      return { ref: string(element.ref), name: string(element.name) };
    }) } : {}),
    ...(Object.hasOwn(value, "result") ? { result: value.result } : {}),
  };
}

/** Read only the native state, never focus, attach, or select a browser view. */
export async function readBrowserState(app: Surface): Promise<BrowserState> {
  const value = await evaluateOnSurface(app, "window.__OPENWORK_ELECTRON__.browser.getState()", { awaitPromise: true });
  if (!record(value) || !Array.isArray(value.tabs) || !Array.isArray(value.nativeViews)) throw new Error("Missing native browser state.");
  return {
    activeTabId: typeof value.activeTabId === "string" ? value.activeTabId : null,
    visibleSessionId: typeof value.visibleSessionId === "string" ? value.visibleSessionId : null,
    tabs: value.tabs.map((tab: unknown) => {
      if (!record(tab)) throw new Error("Invalid browser tab.");
      return { id: string(tab.id), label: string(tab.label), ownerSessionId: typeof tab.ownerSessionId === "string" ? tab.ownerSessionId : null };
    }),
    nativeViews: value.nativeViews.map((view: unknown) => {
      if (!record(view) || typeof view.attached !== "boolean" || typeof view.aboveApp !== "boolean" || typeof view.visible !== "boolean" || !record(view.bounds)
        || typeof view.bounds.x !== "number" || typeof view.bounds.y !== "number" || typeof view.bounds.width !== "number" || typeof view.bounds.height !== "number") {
        throw new Error("Invalid native browser view.");
      }
      return { tabId: string(view.tabId), attached: view.attached, aboveApp: view.aboveApp, visible: view.visible,
        bounds: { x: view.bounds.x, y: view.bounds.y, width: view.bounds.width, height: view.bounds.height } };
    }),
  };
}

export async function readBrowserTabMetrics(app: Surface, targetId: string): Promise<{ width: number; height: number; hasFocus: boolean }> {
  const target = (await listTargets(app.handle.cdpUrl)).find((candidate) => candidate.id === targetId);
  if (!target) throw new Error("The exact browser tab target is no longer available.");
  const client = await connect(debuggerUrlFor(app.handle.cdpUrl, target));
  try {
    const value = await evaluate(client, "({width:innerWidth,height:innerHeight,hasFocus:document.hasFocus()})");
    if (!record(value) || typeof value.width !== "number" || typeof value.height !== "number" || typeof value.hasFocus !== "boolean") throw new Error("Invalid browser metrics.");
    return { width: value.width, height: value.height, hasFocus: value.hasFocus };
  } finally { client.close(); }
}

/** Pure transcript decoding; pending tools have no output to disclose. */
export function browserConversation(value: unknown) {
  if (!Array.isArray(value)) throw new Error("The engine returned no conversation.");
  const calls: Array<{ name: string; status: string; output?: BrowserTaskReply }> = [];
  const answers: string[] = [];
  for (const message of value) {
    if (!record(message) || !record(message.info) || message.info.role !== "assistant" || !Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (!record(part)) continue;
      if (part.type === "text" && typeof part.text === "string") answers.push(part.text);
      if (part.type !== "tool" || typeof part.tool !== "string" || !record(part.state)) continue;
      calls.push({ name: part.tool, status: string(part.state.status),
        ...(typeof part.state.output === "string" ? { output: parseBrowserTaskReply(JSON.parse(part.state.output)) } : {}) });
    }
  }
  return { calls, answer: answers.at(-1) };
}
