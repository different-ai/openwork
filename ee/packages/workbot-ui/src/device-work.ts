import type { RemoteDevice } from "@openwork/types/den/remote-devices";
import type { WorkbotRemoteJob } from "@openwork/types/workbot-remote-jobs";

/**
 * What Workbot is doing on a computer in the Devices list: pure, so it is tested without a page.
 *
 * One of the person's own computers: the remote task this chat started that the computer took or waits for, matched
 * by the id both Den's list and the task's status name the computer by. Workbot's own computer: Den's word that
 * Workbot is working in the computer's chat, which does not prove the computer itself is in use, so the line says
 * where Workbot works rather than what it touches.
 */

/** `needsYou`: the work waits on the person, so the row marks it as theirs to act on rather than as progress. */
export type DeviceWork = { label: string; detail: string | null; needsYou: boolean };

/** A task waiting on the person first, then one that is running, then one the computer has not taken yet. */
const ORDER: Record<string, number> = { waiting: 0, running: 1, starting: 2 };

/**
 * `active`: this chat's remote tasks that are open as of a read just now (`remoteJobActive`). A stale read says
 * nothing about what a computer is doing, so the caller leaves those out.
 */
export function deviceWork(device: Pick<RemoteDevice, "kind" | "provider" | "computerId" | "workingSince">, active: readonly WorkbotRemoteJob[]): DeviceWork | null {
  if (device.provider === "workbot") return device.workingSince ? { label: "Workbot is working in its chat", detail: null, needsYou: false } : null;
  if (device.kind !== "desktop" || device.computerId === null) return null;
  const job = active
    .filter((entry) => entry.status?.computerId === device.computerId && (entry.status.state in ORDER))
    .sort((a, b) => (ORDER[a.status?.state ?? ""] ?? 9) - (ORDER[b.status?.state ?? ""] ?? 9) || (b.startedAt ?? 0) - (a.startedAt ?? 0))[0];
  if (!job?.status) return null;
  if (job.status.state === "waiting") return { label: job.status.waitingFor === "permission" ? "Workbot needs your approval here" : "Workbot needs your answer here", detail: job.title, needsYou: true };
  if (job.status.state === "starting") return { label: "Workbot's task is waiting to start here", detail: job.title, needsYou: false };
  return { label: "Workbot is working here", detail: job.status.latestStep ?? job.title, needsYou: false };
}
