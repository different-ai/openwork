import { useParams } from "react-router";

import { SidebarMenuSubButton, SidebarMenuSubItem } from "@/components/ui/sidebar";
import { remoteSessionRouteId } from "@/lib/remote-session-route";
import { cn } from "@/lib/utils";
import { rememberRemoteHelperOrigin } from "../remote-threads/remote-helper-navigation";
import { useRemoteHelperScope } from "../remote-threads/use-remote-helper-scope";
import { useRemoteThreadOrganization, useRemoteThreadStore } from "../remote-threads/remote-thread-store";
import { remoteThreadStatusWord, remoteThreadView } from "../remote-threads/remote-thread-view";
import { sidebarRowPaddingInlineStart } from "./sidebar-lanes";

const LABEL_LANE_OFFSET_PX = 16 + 8;

type RemoteTaskRow = { threadKey: string; title: string; word: string; waiting: boolean };

function isRow(value: unknown): value is [string, string, string, boolean] {
  return Array.isArray(value) && typeof value[0] === "string" && typeof value[1] === "string"
    && typeof value[2] === "string" && typeof value[3] === "boolean";
}

export function parseRemoteTaskRows(key: string): RemoteTaskRow[] {
  const rows: unknown = JSON.parse(key);
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row) => isRow(row) ? [{ threadKey: row[0], title: row[1], word: row[2], waiting: row[3] }] : []);
}

function useRemoteTaskRowsKey(sessionId: string): string {
  const organizationId = useRemoteThreadOrganization();
  return useRemoteThreadStore((state) => {
    if (!organizationId) return "[]";
    const rows: [string, string, string, boolean][] = [];
    for (const entry of Object.values(state.threads)) {
      if (entry.organizationId !== organizationId) continue;
      if (!Object.values(entry.owners).some((owner) => owner.sessionId === sessionId)) continue;
      const view = remoteThreadView(entry.start, entry, 0);
      rows.push([entry.start.key, view.title, remoteThreadStatusWord(view.state, view.stopped), view.state === "waiting"]);
    }
    return JSON.stringify(rows.sort((left, right) => left[0].localeCompare(right[0])));
  });
}

export function RemoteTaskSidebarRows({ sessionId, sessionTitle, depth = 0, onOpen }: {
  sessionId: string;
  sessionTitle: string;
  depth?: number;
  onOpen: (routeId: string) => void;
}) {
  const key = useRemoteTaskRowsKey(sessionId);
  const scope = useRemoteHelperScope();
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
          style={{ paddingInlineStart: sidebarRowPaddingInlineStart(depth) + LABEL_LANE_OFFSET_PX }}
          onClick={() => {
            const entry = useRemoteThreadStore.getState().threads[row.threadKey];
            const owner = entry ? Object.values(entry.owners).find((candidate) => candidate.sessionId === sessionId) : undefined;
            if (entry && owner) rememberRemoteHelperOrigin({ start: entry.start, owner, parentTitle: sessionTitle }, scope);
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
