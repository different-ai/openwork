/** @jsxImportSource react */
import { useMemo } from "react";
import { Activity, CheckCircle2, ChevronRight, GitBranch, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { getDisplaySessionTitle } from "../../../../app/lib/session-title";
import type { SidebarSessionItem } from "../../../../app/types";
import { t } from "../../../../i18n";
import {
  buildSessionTreeState,
  getRootSessions,
  type SessionTreeState,
} from "../sidebar/utils";

export type WorkflowGraphModalProps = {
  open: boolean;
  workspaceTitle: string | null;
  sessions: SidebarSessionItem[];
  sessionStatusById?: Record<string, string>;
  onSelectSession: (sessionId: string) => void;
  onClose: () => void;
};

export function WorkflowGraphModal(props: WorkflowGraphModalProps) {
  const tree = useMemo(
    () => buildSessionTreeState(props.sessions, props.sessionStatusById),
    [props.sessions, props.sessionStatusById],
  );
  const roots = useMemo(() => getRootSessions(props.sessions), [props.sessions]);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitBranch className="size-4 text-dls-secondary" />
            {t("session.workflow_graph_title")}
          </DialogTitle>
          <DialogDescription>
            {props.workspaceTitle
              ? t("session.workflow_graph_description_workspace", {
                  workspace: props.workspaceTitle,
                })
              : t("session.workflow_graph_description")}
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto pr-1">
          {roots.length === 0 ? (
            <div className="rounded-lg border border-dls-border bg-dls-surface p-6 text-sm text-dls-secondary">
              {t("session.workflow_graph_empty")}
            </div>
          ) : (
            <div className="space-y-3">
              {roots.map((root) => (
                <WorkflowGraphNode
                  key={root.id}
                  session={root}
                  tree={tree}
                  sessionStatusById={props.sessionStatusById}
                  depth={0}
                  onSelectSession={(sessionId) => {
                    props.onClose();
                    props.onSelectSession(sessionId);
                  }}
                />
              ))}
            </div>
          )}
        </div>

        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>
            {t("common.close")}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type WorkflowGraphNodeProps = {
  session: SidebarSessionItem;
  tree: SessionTreeState;
  sessionStatusById?: Record<string, string>;
  depth: number;
  onSelectSession: (sessionId: string) => void;
};

function WorkflowGraphNode(props: WorkflowGraphNodeProps) {
  const { session, tree, sessionStatusById, depth, onSelectSession } = props;
  const children = tree.childrenByParent.get(session.id) ?? [];
  const status = sessionStatusById?.[session.id] ?? "idle";
  const subtreeActive = tree.activeIds.has(session.id);
  const descendantCount = tree.descendantCountBySessionId.get(session.id) ?? 0;
  const title = getDisplaySessionTitle(session.title);

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => onSelectSession(session.id)}
        className={cn(
          "flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left transition-colors",
          subtreeActive
            ? "border-dls-accent/40 bg-dls-accent/5"
            : "border-dls-border bg-dls-surface hover:bg-dls-hover",
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <NodeStatusIcon status={status} active={subtreeActive} />
          <span className="truncate text-sm font-medium text-dls-text">{title}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-xs text-dls-secondary">
          {descendantCount > 0 ? (
            <span>{t("session.workflow_graph_descendants", { count: descendantCount })}</span>
          ) : null}
          <ChevronRight className="size-4 text-dls-secondary" />
        </div>
      </button>

      {children.length > 0 ? (
        <div className="ml-3 border-l border-dls-border pl-4">
          <div className="space-y-2">
            {children.map((child) => (
              <WorkflowGraphNode
                key={child.id}
                session={child}
                tree={tree}
                sessionStatusById={sessionStatusById}
                depth={depth + 1}
                onSelectSession={onSelectSession}
              />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function NodeStatusIcon({ status, active }: { status: string; active: boolean }) {
  if (status === "running" || status === "retry" || status === "busy") {
    return <Loader2 className="size-4 shrink-0 animate-spin text-dls-accent" />;
  }
  if (active) {
    return <Activity className="size-4 shrink-0 text-dls-accent" />;
  }
  if (status === "complete" || status === "done" || status === "ready") {
    return <CheckCircle2 className="size-4 shrink-0 text-green-9" />;
  }
  return <div className="size-2 shrink-0 rounded-full bg-gray-7" aria-hidden />;
}
