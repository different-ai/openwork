import { useParams } from "react-router";

import { SidebarMenuSubButton, SidebarMenuSubItem } from "@/components/ui/sidebar";
import { remoteSessionRouteId } from "@/lib/remote-session-route";
import { cn } from "@/lib/utils";
import { rememberRemoteHelperOrigin } from "../remote-threads/remote-helper-navigation";
import { useRemoteThreadStore } from "../remote-threads/remote-thread-store";
import { remoteThreadStatusWord, remoteThreadView } from "../remote-threads/remote-thread-view";
import { sidebarRowPaddingInlineStart } from "./sidebar-lanes";

/** A session row's 16px glyph slot plus its 8px gap: where every sidebar title starts. */
const LABEL_LANE_OFFSET_PX = 16 + 8;

type RemoteTaskRow = { threadKey: string; title: string; word: string; waiting: boolean };

function isRow(value: unknown): value is [string, string, string, boolean] {
  return Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string"
    && typeof value[2] === "string" && typeof value[3] === "boolean";
}

/** Rows from the compact key: [threadKey, title, word, waiting]. */
export function parseRemoteTaskRows(key: string): RemoteTaskRow[] {
  const rows: unknown = JSON.parse(key);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => isRow(row) ? [{ threadKey: row[0], title: row[1], word: row[2], waiting: row[3] }] : []);
}

/** Tasks a chat started, as a string that only changes when their rows would, so status checks don't re-render the sidebar. */
function useRemoteTaskRowsKey(sessionId: string): string {
  return useRemoteThreadStore((state) => {
    if (!state.helperView) return "[]";
    const rows: [string, string, string, boolean][] = [];
    for (const entry of Object.values(state.threads)) {
      if (!Object.values(entry.owners).some((owner) => owner.sessionId === sessionId)) continue;
      const view = remoteThreadView(entry.start, entry, 0);
      rows.push([entry.start.key, view.title, remoteThreadStatusWord(view.state, view.stopped), view.state === "waiting"]);
    }
    return JSON.stringify(rows.sort((left, right) => left[0].localeCompare(right[0])));
  });
}

/**
 * `remoteSessionHelperView`: tasks a chat started on other computers, listed
 * under that chat with a status word (`Needs you`, `Done`) instead of a dot.
 * The title sits on the sidebar's label lane, the same left edge as the chat
 * title above it, with no glyph of its own. Only tasks this window follows.
 */
export function RemoteTaskSidebarRows({ sessionId, sessionTitle, onOpen }: {
  sessionId: string;
  sessionTitle: string;
  onOpen: (routeId: string) => void;
}) {
  const key = useRemoteTaskRowsKey(sessionId);
  const routeSessionId = useParams<{ sessionId?: string }>().sessionId;
  if (key === "[]") return null;
  return parseRemoteTaskRows(key).map((row) => {
    const routeId = remoteSessionRouteId(row.threadKey);
    const selected = routeSessionId === routeId;
    return (
      <SidebarMenuSubItem key={row.threadKey} className="relative flex items-center" data-sidebar-remote-task={row.threadKey}>
        <SidebarMenuSubButton
          render={<button type="button" />}
          isActive={selected}
          aria-label={`${row.title}, ${row.word}`}
          className="relative h-8 w-full gap-2 rounded-md pe-2.5 text-start text-[13px] text-sidebar-foreground/70 group-hover/menu-sub-item:bg-black/[0.05] data-active:bg-black/[0.07] data-active:text-sidebar-foreground dark:group-hover/menu-sub-item:bg-white/[0.09] dark:data-active:bg-white/[0.12]"
          style={{ paddingInlineStart: sidebarRowPaddingInlineStart(0) + LABEL_LANE_OFFSET_PX }}
          onClick={() => {
            const entry = useRemoteThreadStore.getState().threads[row.threadKey];
            const owner = entry ? Object.values(entry.owners).find((candidate) => candidate.sessionId === sessionId) : undefined;
            if (entry && owner) rememberRemoteHelperOrigin({ start: entry.start, owner, parentTitle: sessionTitle });
            onOpen(routeId);
          }}
        >
          <span className="min-w-0 flex-1 truncate" data-sidebar-remote-task-title="">{row.title}</span>
          <span className={cn("shrink-0 text-[11px]", row.waiting ? "font-medium text-amber-11" : "text-muted-foreground")} data-sidebar-remote-task-word="">
            {row.word}
          </span>
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    );
  });
}
