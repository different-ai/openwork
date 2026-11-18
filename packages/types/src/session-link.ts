/**
 * A session started from another session records where it came from in the
 * OpenCode session's metadata under this key. The engine keeps metadata with
 * the session, so the link is the same on every window and device.
 *
 * - `side`: a side chat a person opened from the parent. Nothing goes back to
 *   the parent.
 * - `sub`: a session the parent's agent started. When it finishes a turn, the
 *   parent gets a short report.
 *
 * The engine copies a session's metadata to the sub-agent sessions and forks
 * made from it. Those copies are not links: readers honor the key only on a
 * session the engine lists as top level (no `parentID`, no `fork`).
 */
export const SESSION_LINK_METADATA_KEY = "openworkSessionLink"

export const SESSION_LINK_KINDS = ["side", "sub"] as const
export type SessionLinkKind = (typeof SESSION_LINK_KINDS)[number]

export type SessionLink = {
  kind: SessionLinkKind
  /** The session this one was started from. */
  parentID: string
}

/** How many levels a session can sit below a top-level session. */
export const SESSION_LINK_MAX_DEPTH = 2

/**
 * The app's read-only query that lists the sessions started from a session.
 * Its result's `canStartLinked` tells the server whether a session the agent
 * starts now is linked to the calling session: the app owns that answer
 * because only it knows whether the feature is on.
 */
export const SESSION_TREE_QUERY_ID = "session.tree"

/**
 * On a user message an agent sent with session.create or session.send: the id
 * of the session that sent it. A message the person typed has no such entry,
 * which is how a report tells a turn its parent asked for from one the person
 * drove.
 */
export const SESSION_PROMPT_SENDER_KEY = "openworkSentBy"

/** `metadata.source` on the note a parent gets when a session its agent started finishes a turn. */
export const SESSION_REPORT_SOURCE = "openwork-session"

function isSessionLinkKind(value: unknown): value is SessionLinkKind {
  return SESSION_LINK_KINDS.some((kind) => kind === value)
}

/** Read a stored link value; anything malformed is no link. */
export function readSessionLink(value: unknown): SessionLink | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null
  const kind: unknown = Reflect.get(value, "kind")
  const parentID: unknown = Reflect.get(value, "parentID")
  if (!isSessionLinkKind(kind) || typeof parentID !== "string" || !parentID.trim()) return null
  return { kind, parentID: parentID.trim() }
}

/** The metadata entry that records a link, for a session create request. */
export function sessionLinkMetadata(link: SessionLink): Record<string, SessionLink> {
  return { [SESSION_LINK_METADATA_KEY]: { kind: link.kind, parentID: link.parentID } }
}
