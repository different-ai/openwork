import type { ComputerSharingState } from "@openwork/types/computer-sharing"
import type { LocalComputerServer } from "@/react-app/infra/local-computer-server"

type Availability = ComputerSharingState["availability"]
type AvailabilityServer = Pick<LocalComputerServer, "identity"> & {
  client: Pick<LocalComputerServer["client"], "getComputerSharingAvailability">
}

const INITIAL_CHECK_MS = 5_000
const STEADY_CHECK_MS = 30_000

export function createComputerRunnerAvailabilityPoller<Server extends AvailabilityServer>({
  readServer, prepareServer, onAvailability, schedule = scheduleTimeout,
}: {
  readServer: () => Promise<Server | null>
  prepareServer: (server: Server | null) => Promise<void>
  onAvailability: (availability: Availability | undefined) => void
  schedule?: (callback: () => void, delay: number) => () => void
}) {
  let lastAnswer: { identity: string; availability: Availability } | undefined
  let cancelTimer: (() => void) | undefined
  let inFlight: AbortController | undefined
  let refreshQueued = false
  let disposed = false

  async function refresh() {
    if (disposed) return
    cancelTimer?.()
    if (inFlight) { refreshQueued = true; return }
    const controller = new AbortController()
    inFlight = controller
    try {
      const server = await readServer().catch(() => null)
      if (controller.signal.aborted) return
      await prepareServer(server)
      if (controller.signal.aborted) return
      const result = await server?.client.getComputerSharingAvailability(controller.signal).catch(() => undefined)
      if (controller.signal.aborted) return
      if (server && result) lastAnswer = { identity: server.identity, availability: result.availability }
      else if (server?.identity !== lastAnswer?.identity) lastAnswer = undefined
      onAvailability(lastAnswer?.availability)
    } finally {
      inFlight = undefined
      if (!disposed) {
        const delay = lastAnswer ? STEADY_CHECK_MS : INITIAL_CHECK_MS
        if (refreshQueued) {
          refreshQueued = false
          void refresh()
        } else {
          cancelTimer = schedule(() => void refresh(), delay)
        }
      }
    }
  }

  return {
    refresh,
    reset() {
      lastAnswer = undefined
      inFlight?.abort()
    },
    dispose() {
      disposed = true
      cancelTimer?.()
      inFlight?.abort()
    },
  }
}

function scheduleTimeout(callback: () => void, delay: number) {
  const timer = setTimeout(callback, delay)
  return () => clearTimeout(timer)
}
