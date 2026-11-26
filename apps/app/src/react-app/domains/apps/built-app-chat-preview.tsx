import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { PanelRightOpen } from "lucide-react";
import { useMessageList } from "@/components/chat/message-list-provider";
import { Button } from "@/components/ui/button";
import { usePanelSessionFor } from "@/react-app/kernel/panel-session-context";
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
  const panelSessionId = usePanelSessionFor(sessionId);
  const latestParts = useContext(LatestBuiltAppPartsContext);
  const app = builtAppSummary(part);
  if (!app) return null;
  return (
    <div
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
            .openTab(panelSessionId, {
              type: "mcp-app",
              id: `mcp-app:${app.appId}`,
              appId: app.appId,
              label: currentApp.title,
              part: currentPart,
              origin: mcpAppOrigin,
            });
          useUiStateStore.getState().setSidePanelState(panelSessionId, "panel");
        }}
      >
        <PanelRightOpen className={compact ? "size-3.5" : "size-4"} />
        {compact ? "Open" : "Open preview"}
      </Button>
    </div>
  );
}

const autoOpened = new Set<string>();

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
  const panelSessionId = usePanelSessionFor(sessionId);
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
      for (const run of appCreationRuns(latestTurn, true)) {
        const read = run.intent?.kind === "edit" ? appRead(run.intent.part) : null;
        if (read) updating.add(read.appId);
      }
    }
    const state = usePanelTabStore.getState();
    const session = state.sessions[panelSessionId];
    if (session?.tabs.some(tab => tab.type === "mcp-app" && Boolean(tab.updating) !== updating.has(tab.appId))) {
      usePanelTabStore.setState({ sessions: { ...state.sessions, [panelSessionId]: { ...session, tabs: session.tabs.map(tab => tab.type === "mcp-app" ? { ...tab, updating: updating.has(tab.appId) } : tab) } } });
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
        .sessions[panelSessionId]?.tabs.find((tab) => tab.id === id);
      const buildKey = `${sessionId}:${part.toolCallId}:${app.revisionId}`;
      const fresh =
        !autoOpened.has(buildKey) &&
        (((active || pending.current.has(part.toolCallId)) &&
          previous !== null &&
          !previous.has(`${part.toolCallId}:${app.revisionId}`)) ||
          (active && turnCalls.has(part.toolCallId)));
      pending.current.delete(part.toolCallId);
      if (tab || (fresh && !readOnly)) {
        const activeTabId =
          usePanelTabStore.getState().sessions[panelSessionId]?.activeTabId ?? null;
        usePanelTabStore
          .getState()
          .openTab(panelSessionId, {
            type: "mcp-app",
            id,
            appId: app.appId,
            updating: updating.has(app.appId),
            label: app.title,
            part,
            origin: mcpAppOrigin,
          });
        if (!fresh)
          usePanelTabStore.getState().selectTab(panelSessionId, activeTabId);
        if (fresh && !readOnly) {
          autoOpened.add(buildKey);
          useUiStateStore.getState().setSidePanelState(panelSessionId, "panel");
        }
      }
    }
  }, [messages, mcpAppOrigin, readOnly, sessionId, panelSessionId, active]);
  return <LatestBuiltAppPartsContext.Provider value={latestParts}>
    {mcpAppOrigin ? <BuiltAppCatalogSync messages={messages} /> : null}
    {children}
  </LatestBuiltAppPartsContext.Provider>;
}
