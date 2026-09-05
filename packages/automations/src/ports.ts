import type {
  Automation,
  AutomationError,
  AutomationRevision,
  AutomationRun,
  AutomationRunEvent,
  AutomationRunEventType,
  AutomationRunReceipt,
  AutomationUsage,
  CreateAutomationDefinition,
  UpdateAutomation,
} from "@openwork/types/automations"

export type Awaitable<T> = T | Promise<T>

export interface AutomationListItem {
  automation: Automation
  revision: AutomationRevision
  latestRun: AutomationRun | null
}

export type AutomationClaimResult =
  | { kind: "claimed"; run: AutomationRun; revision: AutomationRevision }
  | { kind: "duplicate"; run: AutomationRun }
  | { kind: "overlap"; run: AutomationRun }

/** Durable repository boundary. Claims and revision updates must be transactional. */
export interface AutomationRepository {
  create(input: {
    organizationId: string
    ownerMemberId: string
    definition: CreateAutomationDefinition
    now: number
  }): Awaitable<AutomationListItem>
  update(input: {
    organizationId: string
    ownerMemberId: string
    automationId: string
    changes: UpdateAutomation
    now: number
  }): Awaitable<AutomationListItem>
  list(input: { organizationId: string; ownerMemberId: string; cursor?: string; limit: number }): Awaitable<{
    items: AutomationListItem[]
    nextCursor: string | null
  }>
  get(input: { organizationId: string; ownerMemberId: string; automationId: string }): Awaitable<AutomationListItem | null>
  setState(input: {
    organizationId: string
    ownerMemberId: string
    automationId: string
    state: "active" | "inactive" | "archived"
    now: number
  }): Awaitable<AutomationListItem | null>
  listDue(input: { now: number; limit: number }): Awaitable<AutomationListItem[]>
  claim(input: {
    automation: Automation
    revision: AutomationRevision
    trigger: "scheduled" | "recovery" | "manual"
    scheduledFor: number | null
    nonce?: string
    leaseOwner: string
    leaseMs: number
    claimDeadlineMs?: number
    now: number
  }): Awaitable<AutomationClaimResult>
  heartbeat(input: { runId: string; leaseOwner: string; leaseMs: number; now: number }): Awaitable<boolean>
  appendEvent(input: {
    runId: string
    leaseOwner: string
    type: AutomationRunEventType
    payload: Record<string, unknown>
    now: number
  }): Awaitable<AutomationRunEvent>
  complete(input: {
    runId: string
    leaseOwner: string
    status: "succeeded" | "failed" | "cancelled" | "skipped"
    resultSummary: string | null
    usage: AutomationUsage
    error: AutomationError | null
    engineReceipt?: Record<string, unknown> | null
    attempt?: number
    now: number
  }): Awaitable<AutomationRun>
  recoverExpiredLeases(input: { now: number; limit: number }): Awaitable<AutomationRun[]>
  requestCancellation(input: { organizationId: string; ownerMemberId: string; runId: string; now: number }): Awaitable<AutomationRun | null>
  getRunReceipt(input: { organizationId: string; ownerMemberId: string; runId: string }): Awaitable<AutomationRunReceipt | null>
  listRuns(input: { organizationId: string; ownerMemberId: string; automationId: string; cursor?: string; limit: number }): Awaitable<{
    items: AutomationRun[]
    nextCursor: string | null
  }>
}
