const ROUTE_FAILURE = /^route failed: ([A-Za-z]+)\b/
const OWNER_UNREACHABLE = "owner is currently unreachable"

const REASONS: Record<string, string> = {
  CapacityExhausted: "capacity_exhausted",
  NodeUnavailable: "node_unavailable",
  NodeFenced: "node_fenced",
  ResolveFailed: "resolve_failed",
  AcquireFailed: "acquire_failed",
  RestoreFailed: "restore_failed",
  PublishFailed: "publish_failed",
  PeerIncompatible: "peer_incompatible",
}

export const CELL_UNAVAILABLE = "cell_unavailable"

export const CELL_UNAVAILABLE_RETRY_SECONDS = 5

export type CellRouteFailure = { reason: string }

export function cellRouteFailure(error: unknown): CellRouteFailure | null {
  if (!(error instanceof Error)) return null
  const kind = ROUTE_FAILURE.exec(error.message)?.[1]
  if (kind !== undefined) {
    const reason = REASONS[kind]
    return reason === undefined ? null : { reason }
  }
  return error.message.includes(OWNER_UNREACHABLE) ? { reason: "owner_unreachable" } : null
}
