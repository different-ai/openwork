import { remoteDeviceWorkbotReportSchema, type RemoteDeviceWorkbotEvent, type RemoteDeviceWorkbotReport } from "@openwork/types/den/remote-devices"

/**
 * What Workbot tells Den's devices registry about a chat's cloud computer: that a view of it was
 * opened, that it was paused, resumed, rebuilt or handed back, that it could not connect, or that it went with its
 * chat. Fixed names and codes only: never a URL, a screen, or the text of an error.
 *
 * Reports are a courtesy to the registry. Nothing waits for one, and one that fails changes nothing for the person.
 */

/** The runner's desktop codes, as the page is told them. Anything else is reported as the computer being unavailable. */
const DESKTOP_CODES: ReadonlySet<string> = new Set(["desktop_outdated", "desktop_updating", "desktop_unavailable"])
export const desktopReportCode = (code: string | undefined) => (code !== undefined && DESKTOP_CODES.has(code) ? code : "desktop_unavailable")

/** What each of the person's actions on the computer is reported as, once the runner did it. */
export const COMPUTER_ACTION_EVENTS = { continue: "continued", pause: "paused", resume: "resumed", rebuild: "rebuilt" } as const satisfies Record<string, RemoteDeviceWorkbotEvent>

/** The chat's runner session and the chat itself (null for the main chat), as the computer route resolved them. */
export type ComputerTarget = { sessionId: string; chat: string | null }
export type ComputerEvent =
  | { event: "viewer_opened"; view: "browser" | "computer"; control: boolean }
  | { event: "failed"; code: string }
  | { event: Exclude<RemoteDeviceWorkbotEvent, "viewer_opened" | "failed"> }

/** The report Den accepts for an event, or null when it would not be one (a session id that is not a runner's). */
export function computerReport(target: ComputerTarget, input: ComputerEvent): RemoteDeviceWorkbotReport | null {
  const parsed = remoteDeviceWorkbotReportSchema.safeParse({
    sessionId: target.sessionId,
    chat: target.chat ?? "main",
    event: input.event,
    code: input.event === "failed" ? desktopReportCode(input.code) : null,
    view: input.event === "viewer_opened" ? input.view : null,
    control: input.event === "viewer_opened" && input.control,
  })
  return parsed.success ? parsed.data : null
}

/**
 * Reports for one request, sent in the order they happened and never awaited by the request. `enabled` is Den's own
 * answer that Devices is on for the person, read when each report is made; `send` is the call to Den. A refusal
 * (Devices off at Den, signed out), no answer, or a slow answer ends there.
 */
export function createComputerReporter(input: {
  enabled: () => boolean
  send: (report: RemoteDeviceWorkbotReport) => Promise<{ status: number }>
  warn?: (reason: string, event: RemoteDeviceWorkbotEvent) => void
}) {
  const warn = input.warn ?? ((reason, event) => console.warn("[workbot] device_report_failed", { event, reason }))
  let queue: Promise<void> = Promise.resolve()
  return (target: ComputerTarget, event: ComputerEvent): void => {
    if (!input.enabled()) return
    const report = computerReport(target, event)
    if (!report) return
    queue = queue
      .then(() => input.send(report))
      .then(
        // 404 is Den saying Devices is off for the person: its session answer was a moment old. Not worth a line.
        (result) => { if (result.status >= 400 && result.status !== 404) warn(`den_${result.status}`, report.event) },
        (error: unknown) => warn(error instanceof Error ? error.name : "unknown", report.event),
      )
      .catch(() => undefined)
  }
}
