import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { PanelRightOpen } from "lucide-react";
import { useMessageList } from "@/components/chat/message-list-provider";
import { Button } from "@/components/ui/button";
import { usePanelTabStore } from "../session/panel/panel-tab-store";
import { useUiStateStore } from "@/react-app/shell/ui-state-store";
import { appCreationRuns, appRead } from "./app-creation-progress";
import { BuiltAppCatalogSync } from "./built-app-catalog-sync";
import {
  builtAppSummary,
  isAppBuilderPart,
  latestBuiltAppParts,
} from "./built-mcp-app-model";

const LatestBuiltAppPartsContext = createContext<DynamicToolUIPart[]>([]);

export function BuiltAppChatPreview({ part, compact = false }: { part: DynamicToolUIPart; compact?: boolean }) {
  const { sessionId, mcpAppOrigin } = useMessageList();
  const latestParts = useContext(LatestBuiltAppPartsContext);
  const app = builtAppSummary(part);
  if (!app) return null;
  return (
    <div
      // Compact sits on a rail row: same line, same small type as the row.
      className={compact ? "flex shrink-0 items-center" : "mt-2 flex items-center gap-2 text-sm"}
      data-built-app-result={app.appId}
    >
      {!compact ? <span className="min-w-0 flex-1 truncate">{app.title}</span> : null}
      <Button
        variant="ghost"
        size={compact ? "xs" : "sm"}
        aria-label="Open preview"
        disabled={!mcpAppOrigin}
        onClick={() => {
          if (!mcpAppOrigin) return;
          const currentPart = latestParts.find(candidate => builtAppSummary(candidate)?.appId === app.appId) ?? part;
          const currentApp = builtAppSummary(currentPart) ?? app;
          usePanelTabStore
            .getState()
            .openTab(sessionId, {
              type: "mcp-app",
              id: `mcp-app:${app.appId}`,
              appId: app.appId,
              label: currentApp.title,
              part: currentPart,
              origin: mcpAppOrigin,
            });
          useUiStateStore.getState().setSidePanelState(sessionId, "panel");
        }}
      >
        <PanelRightOpen className={compact ? "size-3.5" : "size-4"} />
        {compact ? "Open" : "Open preview"}
      </Button>
    </div>
  );
}

/**
 * Builds that already opened the pane in this window, so switching sessions
 * and back never reopens one the person closed.
 */
const autoOpened = new Set<string>();

/**
 * History is a baseline. A new successful builder result opens the pane, as
 * does one from the turn still running when the chat mounts. An App the agent
 * starts changing is marked Updating but never opened for it: opening runs
 * the App, which needs the person's own click.
 */
export function BuiltAppPreviewSync({
  messages,
  active,
  children,
}: {
  messages: UIMessage[];
  active: boolean;
  children?: ReactNode;
}) {
  const { sessionId, mcpAppOrigin, readOnly } = useMessageList();
  const seen = useRef<Set<string> | null>(null);
  const pending = useRef(new Set<string>());
  const latestParts = useMemo(() => latestBuiltAppParts(messages), [messages]);
  useEffect(() => {
    const updating = new Set<string>();
    const latestTurn = messages.slice(Math.max(0, messages.findLastIndex(message => message.role === "user")));
    if (active) {
      for (const message of latestTurn) for (const part of message.parts) {
        if (part.type !== "dynamic-tool" || !/(?:^|_)update_app$/.test(part.toolName) || (part.state !== "input-streaming" && part.state !== "input-available")) continue;
        const appId = part.input && typeof part.input === "object" ? Reflect.get(part.input, "appId") : null;
        if (typeof appId === "string") updating.add(appId);
      }
      // The agent read an App and is writing its change before update_app exists.
      for (const run of appCreationRuns(latestTurn, true)) {
        const read = run.intent?.kind === "edit" ? appRead(run.intent.part) : null;
        if (read) updating.add(read.appId);
      }
    }
    const state = usePanelTabStore.getState();
    const session = state.sessions[sessionId];
    if (session?.tabs.some(tab => tab.type === "mcp-app" && Boolean(tab.updating) !== updating.has(tab.appId))) {
      usePanelTabStore.setState({ sessions: { ...state.sessions, [sessionId]: { ...session, tabs: session.tabs.map(tab => tab.type === "mcp-app" ? { ...tab, updating: updating.has(tab.appId) } : tab) } } });
    }
    for (const message of messages)
      for (const part of message.parts) {
        if (
          active &&
          part.type === "dynamic-tool" &&
          isAppBuilderPart(part) &&
          (part.state === "input-streaming" || part.state === "input-available")
        )
          pending.current.add(part.toolCallId);
      }
    // Nothing counts as seen until it can open: a build that lands before the
    // App host is known still opens once it is.
    if (!mcpAppOrigin) return;
    const parts = latestBuiltAppParts(messages);
    const previous = seen.current;
    const current = new Set(
      parts.map(
        (part) => `${part.toolCallId}:${builtAppSummary(part)?.revisionId}`,
      ),
    );
    seen.current = new Set([...(previous ?? []), ...current]);
    const turnCalls = new Set(latestTurn.flatMap(message => message.parts.flatMap(part => part.type === "dynamic-tool" ? [part.toolCallId] : [])));
    for (const part of parts) {
      const app = builtAppSummary(part);
      if (!app) continue;
      const id = `mcp-app:${app.appId}`;
      const tab = usePanelTabStore
        .getState()
        .sessions[sessionId]?.tabs.find((tab) => tab.id === id);
      const buildKey = `${sessionId}:${part.toolCallId}:${app.revisionId}`;
      const fresh =
        !autoOpened.has(buildKey) &&
        (((active || pending.current.has(part.toolCallId)) &&
          previous !== null &&
          !previous.has(`${part.toolCallId}:${app.revisionId}`)) ||
          (active && turnCalls.has(part.toolCallId)));
      pending.current.delete(part.toolCallId);
      if (tab || (fresh && !readOnly)) {
        // Updating the same tab keeps the panel in place; closing it stays respected.
        const activeTabId =
          usePanelTabStore.getState().sessions[sessionId]?.activeTabId ?? null;
        usePanelTabStore
          .getState()
          .openTab(sessionId, {
            type: "mcp-app",
            id,
            appId: app.appId,
            updating: updating.has(app.appId),
            label: app.title,
            part,
            origin: mcpAppOrigin,
          });
        if (!fresh)
          usePanelTabStore.getState().selectTab(sessionId, activeTabId);
        if (fresh && !readOnly) {
          autoOpened.add(buildKey);
          useUiStateStore.getState().setSidePanelState(sessionId, "panel");
        }
      }
    }
  }, [messages, mcpAppOrigin, readOnly, sessionId, active]);
  return <LatestBuiltAppPartsContext.Provider value={latestParts}>
    <BuiltAppCatalogSync messages={messages} />
    {children}
  </LatestBuiltAppPartsContext.Provider>;
}
