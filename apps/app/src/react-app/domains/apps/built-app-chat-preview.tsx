import { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import type { DynamicToolUIPart, UIMessage } from "ai";
import { PanelRightOpen } from "lucide-react";
import { useMessageList } from "@/components/chat/message-list-provider";
import { Button } from "@/components/ui/button";
import { usePanelTabStore } from "../session/panel/panel-tab-store";
import { useUiStateStore } from "@/react-app/shell/ui-state-store";
import { appCreationRuns, appRead } from "./app-creation-progress";
import {
  builtAppSummary,
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

/** Refresh only panes the person already opened; publication never opens one. */
export function BuiltAppPreviewSync({
  messages,
  active,
  children,
}: {
  messages: UIMessage[];
  active: boolean;
  children?: ReactNode;
}) {
  const { sessionId, mcpAppOrigin } = useMessageList();
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
    const session = state.sessions[sessionId];
    if (!session) return;
    const tabs = session.tabs.map(tab => {
      if (tab.type !== "mcp-app") return tab;
      const part = latestParts.find(candidate => builtAppSummary(candidate)?.appId === tab.appId);
      const app = part ? builtAppSummary(part) : null;
      const next = {
        ...tab,
        updating: updating.has(tab.appId),
        ...(part && app && mcpAppOrigin ? { part, label: app.title, origin: mcpAppOrigin } : {}),
      };
      return Boolean(tab.updating) === next.updating && tab.part === next.part && tab.label === next.label && tab.origin === next.origin ? tab : next;
    });
    if (tabs.some((tab, index) => tab !== session.tabs[index])) {
      usePanelTabStore.setState({ sessions: { ...state.sessions, [sessionId]: { ...session, tabs } } });
    }
  }, [messages, latestParts, mcpAppOrigin, sessionId, active]);
  return <LatestBuiltAppPartsContext.Provider value={latestParts}>{children}</LatestBuiltAppPartsContext.Provider>;
}
