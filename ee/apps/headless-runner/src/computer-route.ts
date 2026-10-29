import type { SessionComputer } from "./types.js"

/**
 * Each conversation's computer: through the sandbox gateway when its `sandboxGateway` setting is on, else from the
 * runner's own provider. The route is read at every call, so switching the setting moves the conversation's next
 * computer, like switching providers; one already running on the other side pauses and expires there.
 *
 * With the setting on but no gateway configured, the conversation keeps the runner's own provider (logged once);
 * with the gateway configured, its failures reach the conversation as they are, never falling back.
 */
export function routeComputers(input: {
  direct?: SessionComputer
  gateway?: SessionComputer
  viaGateway: (sessionId: string) => boolean
  warn?: (message: string, detail: { sessionId: string }) => void
}): SessionComputer | undefined {
  const { direct, gateway } = input
  const any = direct ?? gateway
  if (!any) return undefined
  const warned = new Set<string>()
  const pick = (sessionId: string): SessionComputer | undefined => {
    if (!input.viaGateway(sessionId)) return direct
    if (gateway) return gateway
    if (!warned.has(sessionId)) {
      warned.add(sessionId)
      ;(input.warn ?? console.warn)("[headless-runner] sandbox gateway asked for but SANDBOX_GATEWAY is off; using the runner's own computer provider", { sessionId })
    }
    return direct
  }
  const routed = (sessionId: string) => {
    const computer = pick(sessionId)
    if (!computer) throw new Error("This runner has no computer for this conversation")
    return computer
  }
  const desktop = (sessionId: string) => {
    const computer = routed(sessionId)
    if (!computer.desktopRun || !computer.desktopViewer || !computer.browserDemonstration || !computer.desktopAction) throw new Error("This conversation's computer has no desktop")
    return computer as Required<SessionComputer>
  }
  // Async throughout, so a missing computer is a rejected call the runner already reports, never a thrown one.
  return {
    prompt: any.prompt,
    tools: any.tools,
    toolNames: any.toolNames,
    image: any.image,
    ...(any.desktopTools ? { desktopTools: any.desktopTools } : {}),
    available: (sessionId) => pick(sessionId) !== undefined,
    desktopRun: async (sessionId, args, signal) => desktop(sessionId).desktopRun(sessionId, args, signal),
    desktopViewer: async (sessionId, view) => desktop(sessionId).desktopViewer(sessionId, view),
    browserDemonstration: async (sessionId, command) => desktop(sessionId).browserDemonstration(sessionId, command),
    desktopAction: async (sessionId, action) => desktop(sessionId).desktopAction(sessionId, action),
    run: async (sessionId, name, args) => routed(sessionId).run(sessionId, name, args),
    known: (sessionId) => pick(sessionId)?.known(sessionId) ?? false,
    prewarm: (sessionId) => pick(sessionId)?.prewarm(sessionId),
    // Both sides: a no-op where the conversation has no computer, and one switched away from still pauses.
    release: (sessionId) => {
      direct?.release(sessionId)
      gateway?.release(sessionId)
    },
    // The conversation's own side must succeed; the other side is cleaned up when it can be.
    delete: async (sessionId) => {
      const own = pick(sessionId)
      const other = own === direct ? gateway : direct
      await Promise.all([own?.delete(sessionId), other?.delete(sessionId).catch(() => undefined)])
    },
    previewSavedFile: async (sessionId, fileId) => {
      await pick(sessionId)?.previewSavedFile(sessionId, fileId)
    },
  }
}
