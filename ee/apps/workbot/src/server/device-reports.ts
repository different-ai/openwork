import { remoteDeviceWorkbotReportSchema, type RemoteDeviceWorkbotEvent, type RemoteDeviceWorkbotReport } from "@openwork/types/den/remote-devices"

const DESKTOP_CODES: ReadonlySet<string> = new Set(["desktop_outdated", "desktop_updating", "desktop_unavailable"])
export const desktopReportCode = (code: string | undefined) => (code !== undefined && DESKTOP_CODES.has(code) ? code : "desktop_unavailable")

export const COMPUTER_ACTION_EVENTS = { continue: "continued", pause: "paused", resume: "resumed", rebuild: "rebuilt" } as const satisfies Record<string, RemoteDeviceWorkbotEvent>

export type ComputerTarget = { sessionId: string; chat: string | null }
export type ComputerEvent =
  | { event: "viewer_opened"; view: "browser" | "computer"; control: boolean }
  | { event: "failed"; code: string }
  | { event: Exclude<RemoteDeviceWorkbotEvent, "viewer_opened" | "failed"> }

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
        (result) => { if (result.status >= 400 && result.status !== 404) warn(`den_${result.status}`, report.event) },
        (error: unknown) => warn(error instanceof Error ? error.name : "unknown", report.event),
      )
      .catch(() => undefined)
  }
}
