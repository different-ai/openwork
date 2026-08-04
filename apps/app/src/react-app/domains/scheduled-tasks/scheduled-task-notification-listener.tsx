/** @jsxImportSource react */
import { useEffect } from "react";

import { notifyScheduledTask } from "@/react-app/shell/notifications";
import type { ScheduledTasksClient } from "./scheduled-tasks-client";

const POLL_INTERVAL_MS = 10_000;

export function ScheduledTaskNotificationListener(props: {
  client: ScheduledTasksClient | null;
  workspaceId: string;
  routeWorkspaceId: string;
}) {
  useEffect(() => {
    if (!props.client || !props.workspaceId || !props.routeWorkspaceId) return undefined;
    let disposed = false;
    let seeded = false;
    let latestRunByTask = new Map<string, string>();

    const poll = async () => {
      try {
        const result = await props.client!.listScheduledTasks(props.workspaceId);
        if (disposed) return;
        const next = new Map<string, string>();
        for (const item of result.items) {
          const run = item.latestRun;
          if (!run) continue;
          const signature = `${run.id}:${run.status}`;
          next.set(item.task.id, signature);
          if (!seeded || latestRunByTask.get(item.task.id) === signature) continue;
          if (run.status === "completed") {
            notifyScheduledTask({
              workspaceId: props.routeWorkspaceId,
              taskId: item.task.id,
              runId: run.id,
              taskName: item.revision.definition.name,
              status: "completed",
            });
          } else if (run.status === "needs-attention") {
            notifyScheduledTask({
              workspaceId: props.routeWorkspaceId,
              taskId: item.task.id,
              runId: run.id,
              taskName: item.revision.definition.name,
              status: "needs-attention",
              detail: run.needsAttention?.message,
            });
          } else if (run.status === "failed" || run.status === "ambiguous") {
            notifyScheduledTask({
              workspaceId: props.routeWorkspaceId,
              taskId: item.task.id,
              runId: run.id,
              taskName: item.revision.definition.name,
              status: "failed",
              detail: run.error?.message,
            });
          }
        }
        latestRunByTask = next;
        seeded = true;
      } catch {
        // Notifications are best-effort and must never affect the active route.
      }
    };

    void poll();
    const interval = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [props.client, props.routeWorkspaceId, props.workspaceId]);

  return null;
}
