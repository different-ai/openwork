import {
  computerFolderSchema,
  computerWholeVmScopeSchema,
  type Computer,
  type ComputerAction,
  type ComputerDecision,
  type ComputerExecution,
  type ComputerGrantScope,
  type ComputerWholeVmScope,
  type ComputerPolicy,
  type ComputerRefusal,
  type ComputerRefusalCode,
  type ComputerState,
  type ComputerToolCall,
} from "@openwork/types/den/computers"
import type { RemoteDeviceKind } from "@openwork/types/den/remote-devices"

export function projectComputer(device: Omit<Computer, "kind"> & { kind: RemoteDeviceKind }): Computer {
  const { id, kind, provider, label, ownerMemberId, availability } = device
  return {
    id,
    kind: kind === "desktop" ? "member_machine" : provider === "workbot" ? "cloud_sandbox" : "registered_vm",
    provider,
    label,
    ownerMemberId,
    availability,
  }
}

export function signedInApp(memberId: string): Computer {
  return {
    id: memberId,
    kind: "member_machine",
    provider: "openwork_desktop",
    label: "This computer",
    ownerMemberId: memberId,
    availability: "online",
  }
}

export function computerState(computer: Pick<Computer, "kind" | "availability">): ComputerState {
  const { kind, availability } = computer
  if (kind === "member_machine") return availability === "online" || availability === "needs_setup" ? "online" : "offline"
  switch (availability) {
    case "online": return "ready"
    case "paused":
    case "unknown": return "starts_when_needed"
    case "offline":
    case "needs_setup": return "has_a_problem"
  }
}

export function matchComputers<T extends Pick<Computer, "id" | "label">>(name: string, computers: readonly T[]): T[] {
  const query = name.trim().toLowerCase()
  if (!query) return []
  const exact = computers.filter(({ label }) => label.toLowerCase() === query)
  if (exact.length) return exact

  const words = query.match(/[\p{L}\p{N}\p{M}]+/gu)
  if (!words) return []
  return computers.filter(({ label }) => {
    const labelWords = label.toLowerCase().match(/[\p{L}\p{N}\p{M}]+/gu)
    return words.every((word) => labelWords?.includes(word))
  })
}

export function uniqueComputerLabel(desired: string, taken: readonly string[], max = 80): string {
  if (!Number.isSafeInteger(max) || max < 1) throw new RangeError("Computer label length must be a positive integer.")
  const existing = new Set(taken.map((label) => label.trim().toLowerCase()))
  const base = desired.trim() || "Computer"
  const fit = (length: number) => base.slice(0, length).replace(/[\uD800-\uDBFF]$/u, "").trimEnd()
  const label = fit(max) || "Computer".slice(0, max)
  if (!existing.has(base.toLowerCase()) && !existing.has(label.toLowerCase())) return label
  for (let number = 2; ; number += 1) {
    const suffix = `(${number})`
    if (suffix.length > max) throw new RangeError("No numbered computer label fits within the maximum length.")
    const prefix = fit(Math.max(0, max - suffix.length - 1))
    const candidate = prefix ? `${prefix} ${suffix}` : suffix
    if (!existing.has(candidate.toLowerCase())) return candidate
  }
}

export function insideSharedFolder(path: string, folders: readonly string[]): boolean {
  return computerFolderSchema.safeParse(path).success && folders.some((folder) =>
    (path === folder || path.startsWith(`${folder}/`)) && computerFolderSchema.safeParse(folder).success,
  )
}

export function computerActionForToolCall(call: ComputerToolCall): ComputerAction {
  switch (call.tool) {
    case "shell": {
      const { command, cwd, timeoutMs } = call.input
      return { type: "shell", command, cwd, timeoutMs }
    }
    case "read": return { type: "read", path: call.input.path }
    case "write":
    case "edit": return { type: "write", path: call.input.path }
    case "glob": return { type: "list", path: call.input.path }
    case "grep": return { type: "search", path: call.input.path }
  }
}

function actionPath(action: ComputerAction): string | undefined {
  return action.type === "shell" ? action.cwd : action.path
}

function directDecision(): ComputerDecision {
  return { outcome: "allow", route: "direct", scope: null }
}

export function refusal(code: ComputerRefusalCode, { label }: Pick<Computer, "label">): ComputerRefusal {
  switch (code) {
    case "organization_off": return {
      outcome: "refuse", layer: "organization", code, changeableBy: "organization_admin",
      message: "I can't do that. Your admin has turned this off for the organization.",
    }
    case "computer_not_allowed": return {
      outcome: "refuse", layer: "computer", code, changeableBy: "computer_owner",
      message: `${label} isn't set to take work from other computers. Its owner decides whether to allow it.`,
    }
    case "not_available_yet": return {
      outcome: "refuse", layer: "computer", code, changeableBy: "no_one",
      message: `${label} can't take work from other computers yet.`,
    }
    case "owner_app_only": return {
      outcome: "refuse", layer: "source", code, changeableBy: "no_one",
      message: `${label} only takes work from its owner's own OpenWork apps.`,
    }
    case "nothing_shared": return {
      outcome: "refuse", layer: "source", code, changeableBy: "computer_owner",
      message: `Nothing on ${label} is shared with me. Its owner decides what to share.`,
    }
    case "folder_not_shared": return {
      outcome: "refuse", layer: "source", code, changeableBy: "computer_owner",
      message: `The folder I need on ${label} isn't shared with me. Its owner decides which folders to share.`,
    }
    case "sandbox_unavailable": return {
      outcome: "refuse", layer: "computer", code, changeableBy: "no_one",
      message: `${label} can't take work from other computers because it can't run the OpenWork sandbox.`,
    }
    case "source_not_allowed": return {
      outcome: "refuse", layer: "source", code, changeableBy: "computer_owner",
      message: `${label} doesn't take work from this computer. Its owner chooses which computers may in Settings > Devices on ${label}.`,
    }
    case "folder_read_only": return {
      outcome: "refuse", layer: "source", code, changeableBy: "computer_owner",
      message: `The folder I need on ${label} is shared read-only. Its owner decides whether it can be edited.`,
    }
    case "not_owner": return {
      outcome: "refuse", layer: "source", code, changeableBy: "no_one",
      message: `${label} only takes work from its owner's own computers.`,
    }
  }
}

export function ownerWholeVmScope(targetId: string, policy: ComputerPolicy): ComputerWholeVmScope | null {
  if (policy.owner.choice !== "allow") return null
  const scope = policy.grants.find((grant) =>
    grant.targetId === targetId && grant.source.kind === "owner" && grant.scope.surface === "whole_vm",
  )?.scope
  const parsed = computerWholeVmScopeSchema.safeParse(scope)
  return parsed.success ? parsed.data : null
}

export function decide(source: Computer, target: Computer, action: ComputerAction, policy: ComputerPolicy): ComputerDecision {
  if (source.id === target.id) return directDecision()
  const sameOwner = source.ownerMemberId !== null && source.ownerMemberId === target.ownerMemberId
  const personal = target.kind === "member_machine"
  if (personal && !sameOwner) return refusal("not_owner", target)
  if (target.kind === "registered_vm" && (!sameOwner || source.kind !== "member_machine")) {
    return refusal("owner_app_only", target)
  }
  if (!policy.organization.allowed) return refusal("organization_off", target)
  if (target.kind === "registered_vm") {
    const scope = ownerWholeVmScope(target.id, policy)
    return scope ? { outcome: "allow", route: "checked", scope } : {
      ...refusal("computer_not_allowed", target),
      message: `I can't use ${target.label}. Its owner can allow access to the entire computer in Settings > Devices.`,
    }
  }
  if (policy.owner.choice !== "allow") return refusal("computer_not_allowed", target)

  const requiresSandbox = personal && policy.organization.requireSandboxOnPersonal
  const grants = requiresSandbox ? policy.grants.filter((grant) => grant.scope.surface === "sandbox") : policy.grants
  const exact = grants.find((grant) =>
    grant.targetId === target.id && grant.source.kind === "computer" && grant.source.id === source.id,
  )
  const owner = !personal && sameOwner && source.kind === "member_machine" ? grants.find((entry) =>
    entry.targetId === target.id && entry.source.kind === "owner",
  ) : undefined
  const workbot = sameOwner && source.provider === "workbot" ? grants.find((entry) =>
    entry.targetId === target.id && entry.source.kind === "workbot",
  ) : undefined
  const grant = exact ?? owner ?? workbot
  if (!grant || grant.scope.surface !== "sandbox") return refusal(personal ? "source_not_allowed" : "nothing_shared", target)
  if (personal && !grant.scope.folders.length) return refusal("nothing_shared", target)

  const path = actionPath(action)
  if (path !== undefined && !insideSharedFolder(path, grant.scope.folders)) {
    return refusal("folder_not_shared", target)
  }
  if (action.type === "write" && !insideSharedFolder(action.path, grant.scope.writableFolders ?? [])) {
    return refusal("folder_read_only", target)
  }
  return { outcome: "allow", route: "checked", scope: grant.scope }
}

export function formatLastSeen(lastSeenAt: string | null, now: number): string {
  if (lastSeenAt === null) return "not seen yet"
  const minutes = Math.floor((now - Date.parse(lastSeenAt)) / 60_000)
  if (minutes < 1) return "less than a minute ago"
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const [amount, unit] = days >= 1 ? [days, "day"] : hours >= 1 ? [hours, "hour"] : [minutes, "minute"]
  return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`
}

export function offlineMessage(label: string, lastSeenAt: string | null, now: number): string {
  return lastSeenAt === null
    ? `${label} is offline and has not been seen yet. Nothing ran there.`
    : `${label} is offline, last seen ${formatLastSeen(lastSeenAt, now)}. Nothing ran there.`
}

export function notPickedUpMessage(label: string, lastSeenAt: string | null, now: number): string {
  const lastSeen = lastSeenAt === null ? "" : `; it was last seen ${formatLastSeen(lastSeenAt, now)}`
  return `${label} didn't respond. It may be asleep${lastSeen}. Nothing ran.`
}

export function createComputers(input: {
  self: Computer
  computers: readonly Computer[]
  policyFor(target: Computer): ComputerPolicy
  lastSeenAt?(target: Computer): string | null
  now?(): number
  run(request: { source: Computer; target: Computer; action: ComputerAction; scope: ComputerGrantScope }): Promise<ComputerExecution>
}): {
  list(): readonly Computer[]
  decide(source: Computer, target: Computer, action: ComputerAction): ComputerDecision
  execute(target: Computer, action: ComputerAction): Promise<ComputerExecution>
} {
  function decideForTarget(source: Computer, target: Computer, action: ComputerAction): ComputerDecision {
    if (source.id === target.id) return directDecision()
    return decide(source, target, action, input.policyFor(target))
  }

  return {
    list: () => input.computers,
    decide: decideForTarget,
    async execute(target, action) {
      const decision = decideForTarget(input.self, target, action)
      if (decision.outcome === "refuse") {
        const { layer, code, message, changeableBy } = decision
        return { state: "refused", layer, code, message, changeableBy }
      }
      if (decision.route === "direct") {
        return { state: "unsupported", message: "Use this chat's own tools to work on this computer." }
      }
      if (target.kind === "member_machine" && target.availability !== "online") {
        const lastSeenAt = input.lastSeenAt?.(target) ?? null
        return { state: "offline", message: offlineMessage(target.label, lastSeenAt, input.now?.() ?? Date.now()), retryable: true, lastSeenAt }
      }
      return input.run({ source: input.self, target, action, scope: decision.scope })
    },
  }
}
