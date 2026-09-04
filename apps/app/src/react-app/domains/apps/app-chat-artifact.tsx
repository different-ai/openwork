import { useEffect, useRef } from "react";
import { Blocks } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMessageList } from "@/components/chat/message-list-provider";
import { useUiStateStore } from "@/react-app/shell/ui-state-store";
import { usePanelTabStore } from "../session/panel/panel-tab-store";
import { useSessionActivityStore } from "../session/status/session-activity-store";
import { type AppReference } from "./app-artifact";

export function AppChatArtifact({ appId, revisionId, receiptId, title }: AppReference & { title: string }) {
  const { sessionId, workspaceId } = useMessageList();
  const opened = useRef(false);
  const open = () => {
    usePanelTabStore.getState().openTab(sessionId, {
      type: "app", id: `app:${appId}:${revisionId}:${receiptId ?? "latest"}`, label: title, appId, revisionId, receiptId,
    });
    useUiStateStore.getState().setSidePanelState(sessionId, "panel");
  };
  useEffect(() => {
    // Replaying history must not take over the user's current panel.
    const activity = useSessionActivityStore.getState().getStatus(workspaceId, sessionId);
    if (!opened.current && (activity === "thinking" || activity === "responding")) { opened.current = true; open(); }
  }, [appId, revisionId, receiptId, sessionId, workspaceId]);
  return <div className="mt-3 overflow-hidden rounded-xl border">
    <div className="flex items-center justify-between gap-3 border-b px-3 py-2"><span className="flex items-center gap-2 text-sm"><Blocks className="size-4" />{title}</span><Button size="sm" variant="ghost" onClick={open}>Open preview</Button></div>
    <p className="px-3 py-3 text-sm text-muted-foreground">Try this app in the preview, ask for changes here, then choose Save app to use it again.</p>
  </div>;
}
