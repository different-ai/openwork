import { createHash } from "node:crypto"

/**
 * Provider-neutral contract between Den and the box that runs one member's
 * cloud browser (a private Daytona sandbox today; Freestyle, a container, or a
 * local process tomorrow).
 *
 * The box only has to run Chrome with a persistent profile and expose its
 * DevTools endpoint privately. Everything else is a stateless CDP call
 * (`page.ts`), so any Den replica can serve the next call: refs live in the
 * page, the profile lives on the box's disk, and nothing lives in Den memory
 * that a different replica would need.
 */

/** Whose browser. One persistent browser profile per organization member. */
export type BrowserKey = {
  organizationId: string
  memberId: string
}

/** Where a running browser listens. Never sent to end users or models. */
export type BrowserEndpoint = {
  /** http(s) base URL serving `/json/version`. */
  cdpUrl: string
  /** Sent on every HTTP request and on the WebSocket upgrade. */
  headers: Record<string, string>
  /** When the endpoint stops working (signed URLs); `null` when stable. */
  expiresAt: Date | null
}

export interface BrowserHost {
  readonly id: string
  /** Idempotent: starts the member's browser if needed and returns where it listens. */
  open(key: BrowserKey, options?: { signal?: AbortSignal }): Promise<BrowserEndpoint>
  /** The endpoint only when the browser is already running. Never starts anything. */
  peek(key: BrowserKey): Promise<BrowserEndpoint | null>
  /** Stops the browser and keeps its profile, so remembered sign-ins survive. */
  stop?(key: BrowserKey): Promise<void>
}

export type CloudBrowserErrorCode =
  // The box
  | "browser_unavailable"
  | "browser_start_failed"
  | "not_running"
  | "timeout"
  // Addresses and tabs
  | "invalid_url"
  | "blocked_url"
  | "navigation_failed"
  | "tab_not_found"
  // Actions
  | "invalid_action"
  | "stale_observation"
  | "stale_element"
  | "sign_in_required"
  | "element_disabled"
  | "element_obscured"
  | "element_outside_viewport"
  | "outside_viewport"
  | "not_editable"
  | "image_required"
  | "unverifiable_focus"
  | "browser_operation_failed"

export class CloudBrowserError extends Error {
  readonly code: CloudBrowserErrorCode
  /** Input may already have reached the page: never repeat the action automatically. */
  readonly dispatched: boolean

  constructor(code: CloudBrowserErrorCode, message: string, options: { dispatched?: boolean; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = "CloudBrowserError"
    this.code = code
    this.dispatched = options.dispatched ?? false
  }
}

export function isCloudBrowserError(error: unknown): error is CloudBrowserError {
  return error instanceof CloudBrowserError
}

/** What the agent should do next after a failure. Mirrors the desktop browser host. */
export function nextStepFor(error: CloudBrowserError): string {
  if (error.dispatched) return "observe_before_retry"
  switch (error.code) {
    case "sign_in_required":
    case "unverifiable_focus":
      return "handoff"
    case "not_running":
    case "tab_not_found":
      return "open"
    case "invalid_url":
    case "blocked_url":
    case "invalid_action":
      return "fix_request"
    case "browser_unavailable":
    case "browser_start_failed":
      return "retry_later"
    default:
      return "observe"
  }
}

/** Stable, opaque id for one member's browser: used for sandbox names and profile folders. */
export function browserKeyId(key: BrowserKey): string {
  return createHash("sha256").update(`${key.organizationId}\0${key.memberId}`).digest("hex").slice(0, 24)
}
