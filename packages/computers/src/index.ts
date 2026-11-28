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

export function insideSharedFolder(path: string, folders: readonly string[]): boolean {
  return computerFolderSchema.safeParse(path).success && folders.some((folder) =>
    (path === folder || path.startsWith(`${folder}/`)) && computerFolderSchema.safeParse(folder).success,
  )
}

function actionPath(action: ComputerAction): string | undefined {
  return action.type === "shell" ? action.cwd : action.path
}

function directDecision(): ComputerDecision {
  return { outcome: "allow", route: "direct", scope: null }
}

export function refusal(code: ComputerRefusalCode, target: Pick<Computer, "label"> & Partial<Pick<Computer, "kind">>): ComputerRefusal {
  switch (code) {
    case "organization_off": return {
      outcome: "refuse", layer: "organization", code, changeableBy: "organization_admin",
      message: "I can't do that. Your admin has turned this off for the organization.",
    }
    case "computer_not_allowed": return {
      outcome: "refuse", layer: "computer", code, changeableBy: "computer_owner",
      message: target.kind === "registered_vm"
        ? `I can't use ${target.label}. Its owner can allow access to the entire computer in Settings > Devices.`
        : `${target.label} isn't set to take work from other computers. Its owner decides whether to allow it.`,
    }
    case "not_available_yet": return {
      outcome: "refuse", layer: "computer", code, changeableBy: "no_one",
      message: `${target.label} can't take work from other computers yet.`,
    }
    case "owner_app_only": return {
      outcome: "refuse", layer: "source", code, changeableBy: "no_one",
      message: `${target.label} only takes work from its owner's own OpenWork apps.`,
    }
    case "nothing_shared": return {
      outcome: "refuse", layer: "source", code, changeableBy: "computer_owner",
      message: `Nothing on ${target.label} is shared with me. Its owner decides what to share.`,
    }
    case "folder_not_shared": return {
      outcome: "refuse", layer: "source", code, changeableBy: "computer_owner",
      message: `The folder I need on ${target.label} isn't shared with me. Its owner decides which folders to share.`,
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
  if (target.kind === "registered_vm" && (!sameOwner || source.kind !== "member_machine")) {
    return refusal("owner_app_only", target)
  }
  if (!policy.organization.allowed) return refusal("organization_off", target)
  if (policy.owner.choice !== "allow") return refusal("computer_not_allowed", target)

  if (target.kind === "registered_vm") {
    const scope = ownerWholeVmScope(target.id, policy)
    return scope ? { outcome: "allow", route: "checked", scope } : refusal("computer_not_allowed", target)
  }

  const grants = policy.grants.filter((grant) => grant.scope.surface === "sandbox")
  const exact = grants.find((grant) =>
    grant.targetId === target.id && grant.source.kind === "computer" && grant.source.id === source.id,
  )
  const grant = exact ?? grants.find((entry) =>
    entry.targetId === target.id && entry.source.kind === "owner" && sameOwner && source.kind === "member_machine",
  ) ?? grants.find((entry) =>
    entry.targetId === target.id && entry.source.kind === "workbot" && sameOwner && source.provider === "workbot",
  )
  if (!grant) return refusal("nothing_shared", target)

  const path = actionPath(action)
  if (path !== undefined && !insideSharedFolder(path, grant.scope.folders)) {
    return refusal("folder_not_shared", target)
  }
  return { outcome: "allow", route: "checked", scope: grant.scope }
}

export function createComputers(input: {
  self: Computer
  computers: readonly Computer[]
  policyFor(target: Computer): ComputerPolicy
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
        return { state: "offline", message: `${target.label} is offline. Try again when it is back online.`, retryable: true }
      }
      return input.run({ source: input.self, target, action, scope: decision.scope })
    },
  }
}
