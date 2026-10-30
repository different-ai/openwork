import { useParams } from "react-router";

import { SidebarMenuSubButton, SidebarMenuSubItem } from "@/components/ui/sidebar";
import { remoteSessionRouteId } from "@/lib/remote-session-route";
import { cn } from "@/lib/utils";
import { rememberRemoteHelperOrigin } from "../remote-threads/remote-helper-navigation";
import { useRemoteThreadChildrenKey, useRemoteThreadStore } from "../remote-threads/remote-thread-store";
import { remoteThreadStatusWord } from "../remote-threads/remote-thread-view";
import { sidebarRowPaddingInlineStart } from "./sidebar-lanes";
import type { RemoteSessionThreadState } from "@openwork/types/automations";

const STATES: readonly RemoteSessionThreadState[] = ["starting", "running", "waiting", "idle", "error"];

function stateOf(value: unknown): RemoteSessionThreadState {
  return STATES.find((state) => state === value) ?? "starting";
}

/** Rows from the store's compact key: [threadKey, title, state]. */
export function parseRemoteTaskRows(key: string): { threadKey: string; title: string; state: RemoteSessionThreadState }[] {
  const rows: unknown = JSON.parse(key);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => {
    if (!Array.isArray(row) || typeof row[0] !== "string" || typeof row[1] !== "string") return [];
    return [{ threadKey: row[0], title: row[1], state: stateOf(row[2]) }];
  });
}

/**
 * `remoteSessionHelperView`: tasks a chat started on other computers, nested
 * under that chat like helpers, each with a status word (`Needs you`,
 * `Done`) instead of a dot. Only tasks this window follows are listed.
 */
export function RemoteTaskSidebarRows({ sessionId, sessionTitle, onOpen }: {
  sessionId: string;
  sessionTitle: string;
  onOpen: (routeId: string) => void;
}) {
  const key = useRemoteThreadChildrenKey(sessionId, true);
  const routeSessionId = useParams<{ sessionId?: string }>().sessionId;
  if (key === "[]") return null;
  return parseRemoteTaskRows(key).map((row) => {
    const routeId = remoteSessionRouteId(row.threadKey);
    const selected = routeSessionId === routeId;
    const word = remoteThreadStatusWord(row.state);
    return (
      <SidebarMenuSubItem key={row.threadKey} className="relative flex items-center" data-sidebar-remote-task={row.threadKey} data-sidebar-remote-task-state={row.state}>
        <SidebarMenuSubButton
          render={<button type="button" />}
          isActive={selected}
          aria-label={`${row.title}, ${word}`}
          className="relative h-8 w-full gap-2 rounded-md pe-2.5 text-start text-[13px] text-sidebar-foreground/80 group-hover/menu-sub-item:bg-black/[0.05] data-active:bg-black/[0.07] data-active:text-sidebar-foreground dark:group-hover/menu-sub-item:bg-white/[0.09] dark:data-active:bg-white/[0.12]"
          style={{ paddingInlineStart: sidebarRowPaddingInlineStart(1) }}
          onClick={() => {
            const entry = useRemoteThreadStore.getState().threads[row.threadKey];
            const owner = entry ? Object.values(entry.owners).find((candidate) => candidate.sessionId === sessionId) : undefined;
            if (entry && owner) rememberRemoteHelperOrigin({ start: entry.start, owner, parentTitle: sessionTitle });
            onOpen(routeId);
          }}
        >
          <span className="min-w-0 flex-1 truncate">{row.title}</span>
          <span className={cn("shrink-0 text-[11px]", row.state === "waiting" ? "font-medium text-amber-11" : "text-muted-foreground")} data-sidebar-remote-task-word="">
            {word}
          </span>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    );
  });
}
