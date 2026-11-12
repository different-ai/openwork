"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { workbotHost } from "./host";

/**
 * An App built in OpenWork, running in the panel beside the chat (`workbotApps`). Workbot's server opens the App from
 * its own MCP server as the person and hands back its page; this component puts the page in an opaque-origin frame
 * and answers the frame's MCP Apps requests. The App's tools run through the server, as the person. The App never
 * gets this page's origin, sign-in or conversation.
 */

const openedSchema = z.object({ html: z.string().min(1), result: z.unknown() });
const calledSchema = z.object({ result: z.unknown() });
const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
const toolCallSchema = z.object({ name: z.string().min(1).max(200), arguments: z.record(z.string(), z.unknown()).optional() });
const linkSchema = z.object({ url: z.string() });

type AppRequest = z.infer<typeof requestSchema>;
type Opened = z.infer<typeof openedSchema>;

/** Opens the App as the person: its page, and what opening it answered. */
async function openApp(appId: string): Promise<Opened> {
  const { response, payload } = await workbotHost().requestJson(`/v1/workbot/apps/${encodeURIComponent(appId)}/open`, { method: "POST", body: "{}" }, 45_000);
  const opened = openedSchema.safeParse(payload);
  if (!response.ok || !opened.success) throw new Error("app_unavailable");
  return opened.data;
}

/** One of the App's own tools, for its page. */
async function callAppTool(appId: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const { response, payload } = await workbotHost().requestJson(`/v1/workbot/apps/${encodeURIComponent(appId)}/call`, { method: "POST", body: JSON.stringify({ name, arguments: args }) }, 45_000);
  const called = calledSchema.safeParse(payload);
  if (!response.ok || !called.success) throw new Error("That didn't work. Try again.");
  return called.data.result;
}

/**
 * What the host answers an App's request with. `reply` and `refuse` answer a request that has an id; `notify` sends
 * the App something it did not ask for. Exported for its test: no frame or network is needed to check the rules.
 */
export async function answerAppRequest(
  request: AppRequest,
  host: { opened: unknown; callTool(name: string, args: Record<string, unknown>): Promise<unknown>; openLink(url: string): void },
  send: { reply(result: unknown): void; refuse(message: string): void; notify(method: string, params: unknown): void },
) {
  switch (request.method) {
    case "ui/initialize":
      return send.reply({
        protocolVersion: typeof request.params?.protocolVersion === "string" ? request.params.protocolVersion : "2026-01-26",
        hostInfo: { name: "Workbot", version: "1.0.0" },
        hostCapabilities: { serverTools: {}, openLinks: {}, logging: {} },
        hostContext: {
          theme: "light",
          displayMode: "fullscreen",
          availableDisplayModes: ["fullscreen"],
          platform: "web",
          locale: navigator.language,
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      });
    case "ui/notifications/initialized":
      send.notify("ui/notifications/tool-input", { arguments: { input: {} } });
      return send.notify("ui/notifications/tool-result", host.opened);
    case "tools/call": {
      const call = toolCallSchema.safeParse(request.params);
      if (!call.success) return send.refuse("That request is not valid.");
      try {
        return send.reply(await host.callTool(call.data.name, call.data.arguments ?? {}));
      } catch (error) {
        return send.refuse(error instanceof Error ? error.message : "That didn't work. Try again.");
      }
    }
    case "ui/open-link": {
      const link = linkSchema.safeParse(request.params);
      const url = link.success && URL.canParse(link.data.url) ? new URL(link.data.url) : null;
      if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) return send.refuse("Only web links can be opened.");
      host.openLink(url.href);
      return send.reply({});
    }
    case "ping":
      return send.reply({});
    default:
      // Notifications (no id) need no answer; anything else Workbot does not offer an App.
      if (request.id !== undefined) send.refuse("Workbot does not support that request.");
  }
}

export function OpenWorkApp({ appId, title }: { appId: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [attempt, setAttempt] = useState(0);
  const [opened, setOpened] = useState<Opened | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setOpened(null);
    setFailed(false);
    openApp(appId).then((value) => { if (!cancelled) setOpened(value); }, () => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [appId, attempt]);

  const onMessage = useCallback((event: MessageEvent) => {
    const target = frame.current?.contentWindow;
    // Only the App's own frame is answered; its origin is opaque, so the source window is what identifies it.
    if (!opened || !target || event.source !== target) return;
    const request = requestSchema.safeParse(event.data);
    if (!request.success) return;
    const post = (message: Record<string, unknown>) => target.postMessage({ jsonrpc: "2.0", ...message }, "*");
    void answerAppRequest(
      request.data,
      {
        opened: opened.result,
        callTool: (name, args) => callAppTool(appId, name, args),
        openLink: (url) => { window.open(url, "_blank", "noopener,noreferrer"); },
      },
      {
        reply: (result) => post({ id: request.data.id, result }),
        refuse: (message) => post({ id: request.data.id, error: { code: -32000, message } }),
        notify: (method, params) => post({ method, params }),
      },
    );
  }, [appId, opened]);

  useEffect(() => {
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onMessage]);

  if (failed) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center" data-workbot-app-failed>
        <p className="text-[13px] leading-5 text-[var(--wb-muted)]">This App couldn&apos;t open. It may have been removed, or not shared with you.</p>
        <button
          type="button"
          onClick={() => setAttempt((current) => current + 1)}
          className="rounded-full bg-[var(--wb-ink)] px-4 py-2 text-[13px] font-medium text-[var(--wb-on-ink)] focus-visible:outline-none focus-visible:shadow-[var(--wb-focus)]"
        >
          Try again
        </button>
      </div>
    );
  }
  if (!opened) {
    return (
      <div className="flex flex-col gap-3 p-6" aria-busy="true" data-workbot-app-loading>
        <span className="aspect-video w-full rounded-xl bg-[var(--wb-chip)]" />
        <span className="h-3 w-2/3 rounded bg-[var(--wb-chip)]" />
      </div>
    );
  }
  // The App's code runs only in an opaque-origin frame: scripts and forms, never this page's origin.
  return <iframe ref={frame} srcDoc={opened.html} sandbox="allow-scripts allow-forms" title={title} className="block min-h-0 w-full flex-1 border-0 bg-white" data-workbot-app-frame />;
}
