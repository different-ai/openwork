import {
  scheduledTaskPlacementSchema,
  type ScheduledTaskCapabilityReference,
  type ScheduledTaskExecutionPrincipal,
  type ScheduledTaskExecutionTarget,
  type ScheduledTaskPlacement,
} from "@openwork/types/scheduled-tasks"

export type ScheduledTaskRepositoryScope =
  | { kind: "all" }
  | { kind: "workspace"; workspaceId: string }
  | { kind: "target"; target: ScheduledTaskExecutionTarget }
  | {
      kind: "scheduler-owner"
      schedulerOwner: "local-server" | "den"
      organizationId?: string
    }

/** A string remains the backward-compatible shorthand for a workspace scope. */
export type ScheduledTaskRepositoryFilter = string | ScheduledTaskRepositoryScope

/**
 * Resolves scopes a local ledger can answer. `undefined` means all local
 * records; `null` means the requested scope belongs to another runtime.
 */
export function localWorkspaceIdForScheduledTaskScope(
  scope?: ScheduledTaskRepositoryFilter,
): string | null | undefined {
  if (scope === undefined || (typeof scope !== "string" && scope.kind === "all")) {
    return undefined
  }
  if (typeof scope === "string") return scope
  if (scope.kind === "workspace") return scope.workspaceId
  if (scope.kind === "target") {
    return scope.target.kind === "local-workspace"
      ? scope.target.workspaceId
      : null
  }
  return scope.schedulerOwner === "local-server" ? undefined : null
}

function targetIdentity(target: ScheduledTaskExecutionTarget): string {
  return target.kind === "local-workspace"
    ? `local:${target.workspaceId}`
    : `den:${target.organizationId}:${target.workerId}:${target.workspaceId}`
}

function principalIdentity(principal: ScheduledTaskExecutionPrincipal): string {
  return principal.kind === "local-user"
    ? `local:${principal.identityId}`
    : `den:${principal.organizationId}:${principal.membershipId}`
}

function capabilityIdentity(reference: ScheduledTaskCapabilityReference): string {
  return [
    reference.source,
    reference.id,
    reference.actionClass,
    reference.reviewedVersion ?? "",
    reference.reviewedDigest ?? "",
  ].map(encodeURIComponent).join(":")
}

/** A stable, non-secret identity used to decide whether authority must be reviewed again. */
export function scheduledTaskPlacementIdentity(
  input: ScheduledTaskPlacement,
): string {
  const placement = scheduledTaskPlacementSchema.parse(input)
  const capabilities = placement.capabilityReferences
    .map(capabilityIdentity)
    .sort()
    .join(",")
  return [
    targetIdentity(placement.target),
    placement.schedulerOwner,
    placement.executionAvailability,
    principalIdentity(placement.executionPrincipal),
    capabilities,
  ].map(encodeURIComponent).join("|")
}

export function scheduledTaskPlacementNeedsReview(
  previous: ScheduledTaskPlacement,
  next: ScheduledTaskPlacement,
): boolean {
  return (
    scheduledTaskPlacementIdentity(previous) !==
    scheduledTaskPlacementIdentity(next)
  )
}
