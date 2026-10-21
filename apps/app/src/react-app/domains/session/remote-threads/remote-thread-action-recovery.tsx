import { Button } from "@/components/ui/button"
import { TaskRecovery } from "@/components/chat/task-recovery"
import { checkRemoteThreadAction } from "./remote-thread-actions"
import type { RemoteThreadAction, RemoteThreadEntry } from "./remote-thread-store"

/** One receipt and one recovery action, wherever this task is shown. */
export function RemoteThreadActionRecovery({ entry, action, followUpId }: { entry: RemoteThreadEntry; action: RemoteThreadAction | null; followUpId?: string }) {
  if (!action?.message) return null
  return <TaskRecovery compact state={action.phase === "failed" ? "failed" : "paused"} title={action.message}
    actions={action.requestId ? <Button variant="ghost" size="xs" disabled={action.phase === "requesting"}
      onClick={() => void checkRemoteThreadAction(entry, followUpId)}>Check again</Button> : undefined} />
}
