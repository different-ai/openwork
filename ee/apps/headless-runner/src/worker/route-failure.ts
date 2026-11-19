/**
 * What the cell host (celld) throws from a cell's `fetch` when it could not deliver the request to the cell at all:
 * `route failed: <kind>`, or its message for an owner node that does not answer. The cell's code never ran, so the
 * caller may send the same request again.
 *
 * The usual cause is a node that refuses to start cells because its memory is over its ceiling (`CapacityExhausted`):
 * a hibernated cell wakes only on the node that owns it, so the conversation stays unreachable until that node has
 * room again or hands the cell to another node (OWNER-CELLS.md, "When a node is full"). The others are a node
 * restarting or losing its lease.
 *
 * `RuntimeFailed` (the cell's code failed to start) and `DurabilityUnproven` (a write ran but could not be proven
 * saved) are left out on purpose: those are failures to look at, not a cell to wait for.
 */
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

/** The answer's error code: the conversation's cell cannot be reached right now, and nothing of the request ran. */
export const CELL_UNAVAILABLE = "cell_unavailable"

/** How long a caller should wait before sending the request again. The host already held it for its own deadline. */
export const CELL_UNAVAILABLE_RETRY_SECONDS = 5

export type CellRouteFailure = { reason: string }

/** Why the host could not reach the cell, or null when the error is anything else. */
export function cellRouteFailure(error: unknown): CellRouteFailure | null {
  if (!(error instanceof Error)) return null
  const kind = ROUTE_FAILURE.exec(error.message)?.[1]
  if (kind !== undefined) {
    const reason = REASONS[kind]
    return reason === undefined ? null : { reason }
  }
  return error.message.includes(OWNER_UNREACHABLE) ? { reason: "owner_unreachable" } : null
}
