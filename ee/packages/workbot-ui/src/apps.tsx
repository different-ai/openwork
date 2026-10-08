"use client";

import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { CircleAlert } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { callWorkbotAppTool, setWorkbotAppContext, useWorkbotApp, useWorkbotChat, type WorkbotAppView } from "./data";
import { AppMark } from "./files";
import { workbotHost } from "./host";

/** The App sets its own height, within these bounds; it never scrolls the chat (DESIGN S4). */
const MIN_HEIGHT = 48;
const MAX_HEIGHT = 800;
const START_HEIGHT = 240;
/** From loading the sandbox to the App saying it is ready. */
const OPEN_TIMEOUT_MS = 20_000;
/** A browser treats a click or key press as fresh for about this long: one gesture sends at most one message. */
const GESTURE_MS = 5_000;

/** Only web links open, in a new tab, never with access back to Workbot. */
function webLink(url: string) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * The person just clicked or typed in this App: the browser's own record of a real gesture (scripts can't fake it),
 * while focus is inside the App's frame, so a gesture elsewhere on the page never counts for it.
 */
const actedIn = (frame: HTMLIFrameElement) => navigator.userActivation?.isActive === true && document.activeElement === frame;

/**
 * An App a tool result opened, inside the reply that opened it (DESIGN T3, S4): a 40px header with where it came from
 * and its name, then the App. It opens with the input and result it opened with, every time.
 */
export default function WorkbotAppCard({ turnId, callId, app, onMessage }: { turnId: string; callId: string; app: string | null; onMessage: (text: string) => void }) {
  const view = useWorkbotApp(turnId, callId);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const title = view.data?.title ?? app ?? "App";
  const error = view.error?.message ?? failure;
  const retry = () => {
    setFailure(null);
    setAttempt((count) => count + 1);
    if (view.isError) void view.refetch();
  };
  return (
    <section
      aria-label={title}
      data-workbot-app={callId}
      aria-busy={!view.data && !error}
      className="workbot-row-enter my-1.5 flex w-full flex-col overflow-hidden rounded-[16px] bg-[var(--wb-surface)] shadow-[var(--wb-card-shadow)] sm:max-w-[600px]"
    >
      <header className="flex h-10 shrink-0 items-center gap-2 px-3.5 text-[13px] font-medium leading-4 text-[var(--wb-text)] shadow-[0_1px_0_var(--wb-hairline)]">
        {app ? <AppMark name={app} size={16} /> : null}
        <span className="truncate">{title}</span>
      </header>
      {error ? (
        <div role="status" className="flex min-h-12 items-center gap-1.5 px-3.5 text-[13px] leading-4 text-[var(--wb-muted)]">
          <CircleAlert size={14} strokeWidth={1.75} aria-hidden className="shrink-0 text-[var(--wb-danger)]" />
          <span>{error}</span>
          <button
            type="button"
            onClick={retry}
            className="-my-1 ml-0.5 h-7 shrink-0 rounded-full px-2.5 font-medium text-[var(--wb-text)] transition-colors duration-150 hover:bg-[var(--wb-chip)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
          >
            Try again
          </button>
        </div>
      ) : view.data ? (
        <AppFrame key={attempt} view={view.data} turnId={turnId} callId={callId} onMessage={onMessage} onFail={setFailure} />
      ) : (
        <div aria-hidden className="bg-[var(--wb-tray)]" style={{ height: START_HEIGHT }} />
      )}
    </section>
  );
}

/**
 * The App itself, in the MCP Apps sandbox (an origin of its own, under the policy it declared), connected to Workbot
 * through the standard MCP Apps bridge: it gets its input and result, runs its own tools, tells the model what it
 * shows, and, right after the person's click, sends a message as them or opens a link.
 */
function AppFrame(props: { view: WorkbotAppView; turnId: string; callId: string; onMessage: (text: string) => void; onFail: (message: string) => void }) {
  const { view, turnId, callId } = props;
  const chat = useWorkbotChat();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(START_HEIGHT);
  const latest = useRef(props);
  latest.current = props;

  useLayoutEffect(() => {
    const frame = frameRef.current;
    const target = frame?.contentWindow;
    const sandboxUrl = workbotHost().appSandboxUrl;
    if (!frame || !target) return;
    if (!sandboxUrl) {
      latest.current.onFail("Apps can't open here.");
      return;
    }
    let closed = false;
    let connected = false;
    let messagedAt = Number.NEGATIVE_INFINITY;
    const bridge = new AppBridge(
      null,
      { name: "Workbot", version: "1.0.0" },
      { serverTools: {}, openLinks: {}, message: { text: {} }, updateModelContext: { text: {}, structuredContent: {} } },
      {
        hostContext: {
          theme: "light",
          displayMode: "inline",
          availableDisplayModes: ["inline"],
          platform: "web",
          locale: navigator.language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          containerDimensions: { maxHeight: MAX_HEIGHT, maxWidth: 600 },
        },
      },
    );
    const close = () => {
      if (closed) return;
      closed = true;
      window.removeEventListener("message", onSandboxReady);
      window.clearTimeout(timer);
      const finish = () => void bridge.close().catch(() => undefined);
      if (connected) void bridge.teardownResource({}).catch(() => undefined).finally(finish);
      else finish();
    };
    const fail = () => {
      if (closed) return;
      close();
      latest.current.onFail("This App didn't open.");
    };

    bridge.onsizechange = ({ height: wanted }) => {
      if (wanted !== undefined && Number.isFinite(wanted) && wanted > 0) setHeight(Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.ceil(wanted))));
    };
    bridge.oncalltool = async ({ name, arguments: args, _meta }) => {
      const result = await callWorkbotAppTool(chat, turnId, callId, { name, arguments: args ?? {}, clicked: _meta?.["openwork/userInteraction"] === true });
      return CallToolResultSchema.parse(result);
    };
    bridge.onupdatemodelcontext = async ({ content, structuredContent }) => {
      await setWorkbotAppContext(chat, turnId, callId, { title: view.title, ...(content ? { content } : {}), ...(structuredContent ? { structuredContent } : {}) });
      return {};
    };
    // Sending a message as the person, or opening a link, needs their gesture in the App; a message, once per gesture.
    bridge.onmessage = async ({ content }) => {
      const text = content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n").trim();
      if (!text || !actedIn(frame) || Date.now() - messagedAt < GESTURE_MS) return { isError: true };
      messagedAt = Date.now();
      latest.current.onMessage(text);
      return {};
    };
    bridge.onopenlink = async ({ url }) => {
      const link = webLink(url);
      if (!link || !actedIn(frame)) return { isError: true };
      window.open(link, "_blank", "noopener,noreferrer");
      return {};
    };
    bridge.oninitialized = () => {
      window.clearTimeout(timer);
      const result = view.result ? CallToolResultSchema.safeParse(view.result) : null;
      void bridge
        .sendToolInput({ arguments: view.input })
        .then(() => (result?.success ? bridge.sendToolResult(result.data) : undefined))
        .catch(fail);
    };

    // The sandbox runs without same-origin access, so its messages come from the opaque origin "null".
    const onSandboxReady = (event: MessageEvent) => {
      if (event.source !== target || event.origin !== "null" || typeof event.data !== "object" || event.data?.method !== "ui/notifications/sandbox-proxy-ready") return;
      window.removeEventListener("message", onSandboxReady);
      void bridge
        .connect(new PostMessageTransport(target, target))
        .then(() => {
          connected = true;
          return bridge.sendSandboxResourceReady({ html: view.html, csp: view.csp, sandbox: "allow-scripts" });
        })
        .catch(fail);
    };
    window.addEventListener("message", onSandboxReady);
    const timer = window.setTimeout(fail, OPEN_TIMEOUT_MS);
    const url = new URL(sandboxUrl, window.location.href);
    url.searchParams.set("csp", JSON.stringify(view.csp));
    url.searchParams.set("hostOrigin", window.location.origin);
    frame.src = url.toString();
    return close;
  }, [view, turnId, callId, chat]);

  return (
    <iframe
      ref={frameRef}
      title={view.title}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="block w-full border-0 bg-transparent"
      style={{ height }}
    />
  );
}
