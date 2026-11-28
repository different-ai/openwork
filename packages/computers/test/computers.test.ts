import assert from "node:assert/strict"
import { test } from "node:test"
import { computerState, createComputers, decide, insideSharedFolder, matchComputers, projectComputer, refusal, signedInApp } from "@openwork/computers"
import { COMPUTER_KINDS, type Computer, type ComputerAction, type ComputerExecution, type ComputerGrant, type ComputerPolicy, type ComputerState } from "@openwork/types/den/computers"
import { REMOTE_DEVICE_AVAILABILITIES } from "@openwork/types/den/remote-devices"

const source: Computer = {
  id: "workbot-computer", kind: "cloud_sandbox", provider: "workbot", label: "Workbot", ownerMemberId: "ada", availability: "online",
}
const target: Computer = {
  id: "member-computer", kind: "member_machine", provider: "openwork_desktop", label: "Ada's MacBook", ownerMemberId: "ada", availability: "online",
}
const action: ComputerAction = { type: "shell", command: "true" }

test("stored refusal codes reproduce the layer, owner and exact sentence", () => {
  assert.deepEqual(refusal("organization_off", target), {
    outcome: "refuse", layer: "organization", code: "organization_off", changeableBy: "organization_admin",
    message: "I can't do that. Your admin has turned this off for the organization.",
  })
  assert.deepEqual(refusal("computer_not_allowed", target), {
    outcome: "refuse", layer: "computer", code: "computer_not_allowed", changeableBy: "computer_owner",
    message: "Ada's MacBook isn't set to take work from other computers. Its owner decides whether to allow it.",
  })
  assert.deepEqual(refusal("nothing_shared", target), {
    outcome: "refuse", layer: "source", code: "nothing_shared", changeableBy: "computer_owner",
    message: "Nothing on Ada's MacBook is shared with me. Its owner decides what to share.",
  })
  assert.deepEqual(refusal("folder_not_shared", target), {
    outcome: "refuse", layer: "source", code: "folder_not_shared", changeableBy: "computer_owner",
    message: "The folder I need on Ada's MacBook isn't shared with me. Its owner decides which folders to share.",
  })
  assert.deepEqual(refusal("not_available_yet", target), {
    outcome: "refuse", layer: "computer", code: "not_available_yet", changeableBy: "no_one",
    message: "Ada's MacBook can't take work from other computers yet.",
  })
})
const workbot: ComputerGrant = { source: { kind: "workbot" }, targetId: target.id, scope: { surface: "sandbox", folders: ["/a/logs"] } }
const exact: ComputerGrant = { source: { kind: "computer", id: source.id }, targetId: target.id, scope: { surface: "sandbox", folders: ["/exact"] } }

function policy(grants: ComputerGrant[] = [workbot]): ComputerPolicy {
  return { organization: { allowed: true, requireSandboxOnPersonal: true }, owner: { choice: "allow" }, grants }
}

function checked(grant: ComputerGrant) {
  return { outcome: "allow", route: "checked", scope: grant.scope }
}

const organizationRefusal = {
  outcome: "refuse", layer: "organization", code: "organization_off", changeableBy: "organization_admin",
  message: "I can't do that. Your admin has turned this off for the organization.",
}
const computerRefusal = {
  outcome: "refuse", layer: "computer", code: "computer_not_allowed", changeableBy: "computer_owner",
  message: "Ada's MacBook isn't set to take work from other computers. Its owner decides whether to allow it.",
}
const sourceRefusal = {
  outcome: "refuse", layer: "source", code: "nothing_shared", changeableBy: "computer_owner",
  message: "Nothing on Ada's MacBook is shared with me. Its owner decides what to share.",
}

test("a whole-computer grant never counts as a sandbox grant on a personal computer", () => {
  const whole: ComputerGrant = { ...exact, scope: { surface: "whole_vm", folders: ["/workspace"] } }
  assert.deepEqual(decide(source, target, action, policy([whole])), sourceRefusal)
  assert.deepEqual(decide(source, target, action, policy([whole, workbot])), checked(workbot))
  const sandboxNotRequired = { ...policy([whole]), organization: { allowed: true, requireSandboxOnPersonal: false } }
  assert.deepEqual(decide(source, target, action, sandboxNotRequired), sourceRefusal)
})

for (const allowed of [false, true]) {
  for (const choice of [null, "off", "allow"] as const) {
    for (const shared of [false, true]) {
      test(`decision: organization allowed=${allowed}, owner=${choice}, source shared=${shared}`, () => {
        const snapshot: ComputerPolicy = { organization: { allowed, requireSandboxOnPersonal: true }, owner: { choice }, grants: shared ? [workbot] : [] }
        const expected = !allowed ? organizationRefusal : choice !== "allow" ? computerRefusal : shared ? checked(workbot) : sourceRefusal
        assert.deepEqual(decide(source, target, action, snapshot), expected)
      })
    }
  }
}

test("projectComputer maps device kinds and keeps only public computer fields", () => {
  const desktop = { ...target, kind: "desktop", externalId: "device" } as const
  assert.deepEqual(projectComputer(desktop), target)
  assert.deepEqual(projectComputer({ ...source, kind: "vm" }), source)
  const vm = { ...source, provider: "freestyle", ownerMemberId: null, availability: "unknown" } as const
  assert.deepEqual(projectComputer({ ...vm, kind: "vm" }), { ...vm, kind: "registered_vm" })
  assert.deepEqual(projectComputer({ ...source, kind: "desktop" }), { ...source, kind: "member_machine" })
})

test("exact source grants win regardless of order, without falling back for another folder", () => {
  for (const grants of [[workbot, exact], [exact, workbot]]) {
    assert.deepEqual(decide(source, target, action, policy(grants)), checked(exact))
    assert.deepEqual(decide(source, target, { ...action, cwd: "/exact" }, policy(grants)), checked(exact))
    assert.deepEqual(decide(source, target, { ...action, cwd: "/a/logs" }, policy(grants)), {
      outcome: "refuse", layer: "source", code: "folder_not_shared", changeableBy: "computer_owner",
      message: "The folder I need on Ada's MacBook isn't shared with me. Its owner decides which folders to share.",
    })
  }
})

test("grants must name this target and exact grants must name this source", () => {
  assert.deepEqual(decide(source, target, action, policy([{ ...workbot, targetId: "other-target" }])), sourceRefusal)
  assert.deepEqual(decide(source, target, action, policy([{ ...exact, targetId: "other-target" }])), sourceRefusal)
  assert.deepEqual(decide(source, target, action, policy([{ ...exact, source: { kind: "computer", id: "other-source" } }])), sourceRefusal)
})

test("a Workbot grant covers the owner's other chats, but not another member or two unowned devices", () => {
  assert.deepEqual(decide({ ...source, id: "second-chat" }, target, action, policy()), checked(workbot))
  assert.deepEqual(decide({ ...source, ownerMemberId: "sam" }, target, action, policy()), sourceRefusal)
  assert.deepEqual(decide({ ...source, ownerMemberId: "sam" }, target, action, policy([exact])), checked(exact))
  assert.deepEqual(decide(source, { ...target, ownerMemberId: null }, action, policy()), sourceRefusal)
  assert.deepEqual(decide({ ...source, ownerMemberId: null }, { ...target, ownerMemberId: null }, action, policy()), sourceRefusal)
})

test("a registered VM needs an exact grant even when its owner matches", () => {
  const vm: Computer = { ...source, kind: "registered_vm", provider: "daytona" }
  assert.deepEqual(decide(vm, target, action, policy()), sourceRefusal)
  assert.deepEqual(decide(vm, target, action, policy([workbot, exact])), checked(exact))
})

test("signedInApp projects a member's sign-in, not a device", () => {
  assert.deepEqual(signedInApp("ada"), {
    id: "ada", kind: "member_machine", provider: "openwork_desktop", label: "This computer", ownerMemberId: "ada", availability: "online",
  })
})

const owner: ComputerGrant = { source: { kind: "owner" }, targetId: target.id, scope: { surface: "sandbox", folders: ["/workspace"] } }

test("owner grants cover only member machines with the target's non-null owner", () => {
  const app = signedInApp("ada")
  assert.deepEqual(decide(app, target, action, policy([owner])), checked(owner))
  assert.deepEqual(decide({ ...app, id: "second-app" }, target, action, policy([owner])), checked(owner))
  assert.deepEqual(decide(signedInApp("sam"), target, action, policy([owner])), sourceRefusal)
  assert.deepEqual(decide(source, target, action, policy([owner])), sourceRefusal)
  assert.deepEqual(decide({ ...source, kind: "registered_vm" }, target, action, policy([owner])), sourceRefusal)
  assert.deepEqual(decide({ ...app, ownerMemberId: null }, { ...target, ownerMemberId: null }, action, policy([owner])), sourceRefusal)
  assert.deepEqual(decide(app, target, action, policy([{ ...owner, targetId: "other-target" }])), sourceRefusal)
})

test("registered VMs require a whole-VM grant for the owning member's app", () => {
  const vm: Computer = { ...target, kind: "registered_vm", provider: "daytona" }
  const wholeVm: ComputerGrant = { ...owner, scope: { surface: "whole_vm", folders: ["/workspace"] } }
  const inside = { type: "read", path: "/workspace/notes.txt" } satisfies ComputerAction
  const outside = { type: "read", path: "/project/notes.txt" } satisfies ComputerAction
  const app = signedInApp("ada")
  const refused = {
    outcome: "refuse", layer: "computer", code: "computer_not_allowed", changeableBy: "computer_owner",
    message: "I can't use Ada's MacBook. Its owner can allow access to the entire computer in Settings > Devices.",
  }
  const ownerAppOnly = {
    outcome: "refuse", layer: "source", code: "owner_app_only", changeableBy: "no_one",
    message: "Ada's MacBook only takes work from its owner's own OpenWork apps.",
  }
  assert.deepEqual(decide(app, vm, inside, policy([owner])), refused)
  assert.deepEqual(decide(app, vm, inside, policy([{ ...wholeVm, source: { kind: "computer", id: app.id } }])), refused)
  assert.deepEqual(decide(app, vm, inside, policy([wholeVm])), checked(wholeVm))
  assert.deepEqual(decide(app, vm, outside, policy([wholeVm])), checked(wholeVm))
  assert.deepEqual(decide(signedInApp("sam"), vm, inside, policy([wholeVm])), ownerAppOnly)
  assert.deepEqual(decide(source, vm, inside, policy([wholeVm])), ownerAppOnly)
  assert.deepEqual(decide(source, vm, inside, { ...policy(), owner: { choice: "off" } }), ownerAppOnly)
  assert.deepEqual(decide(app, target, inside, policy([wholeVm])), sourceRefusal)
  assert.deepEqual(decide(app, target, inside, policy([wholeVm, owner])), checked(owner))
})

test("when all grants match, exact wins over owner and owner wins over Workbot without folder fallback", () => {
  const desktop = { ...source, kind: "member_machine" } satisfies Computer
  for (const grants of [[workbot, owner, exact], [exact, owner, workbot]]) {
    assert.deepEqual(decide(desktop, target, action, policy(grants)), checked(exact))
  }
  for (const grants of [[owner, workbot], [workbot, owner]]) {
    assert.deepEqual(decide(desktop, target, action, policy(grants)), checked(owner))
    const read: ComputerAction = { type: "read", path: "/a/logs" }
    assert.deepEqual(decide(desktop, target, read, policy(grants)), refusal("folder_not_shared", target))
  }
})

test("reads, writes, lists and searches use the same early path check without repeating a raw path in refusals", () => {
  const pathTypes: Exclude<ComputerAction["type"], "shell">[] = ["read", "write", "list", "search"]
  for (const type of pathTypes) {
    for (const path of ["/workspace", "/workspace/artifacts"]) {
      assert.deepEqual(decide(signedInApp("ada"), target, { type, path }, policy([owner])), checked(owner))
    }
    const decision = decide(signedInApp("ada"), target, { type, path: "/workspace-other/member-computer" }, policy([owner]))
    assert.deepEqual(decision, {
      outcome: "refuse", layer: "source", code: "folder_not_shared", changeableBy: "computer_owner",
      message: "The folder I need on Ada's MacBook isn't shared with me. Its owner decides which folders to share.",
    })
  }
  assert.deepEqual(decide(signedInApp("ada"), target, { type: "list" }, policy([owner])), checked(owner))
  assert.deepEqual(decide(signedInApp("ada"), target, { type: "search" }, policy([owner])), checked(owner))
})

test("insideSharedFolder rejects invalid paths, invalid shares and non-descendants", () => {
  assert.equal(insideSharedFolder("/workspace", ["/workspace"]), true)
  assert.equal(insideSharedFolder("/workspace/src/index.ts", ["/other", "/workspace"]), true)
  for (const path of ["/", "/workspace-extra", "workspace/src", "/workspace/../other", "/workspace//src", "/workspace/"]) {
    assert.equal(insideSharedFolder(path, ["/workspace"]), false, path)
  }
  assert.equal(insideSharedFolder("/workspace", [""]), false)
  assert.equal(insideSharedFolder("/workspace", []), false)
})

const states: Record<Computer["kind"], Record<Computer["availability"], ComputerState>> = {
  member_machine: { online: "online", needs_setup: "online", paused: "offline", offline: "offline", unknown: "offline" },
  registered_vm: { online: "ready", needs_setup: "has_a_problem", paused: "starts_when_needed", offline: "has_a_problem", unknown: "starts_when_needed" },
  cloud_sandbox: { online: "ready", needs_setup: "has_a_problem", paused: "starts_when_needed", offline: "has_a_problem", unknown: "starts_when_needed" },
}

for (const kind of COMPUTER_KINDS) {
  test(`computerState maps every availability for ${kind}`, () => {
    for (const availability of REMOTE_DEVICE_AVAILABILITIES) {
      assert.equal(computerState({ kind, availability }), states[kind][availability], availability)
    }
  })
}

const buildBox = { id: "build", label: "Build box" }
const adaBox = { id: "ada-build", label: "Ada's build box" }
const samBox = { id: "sam-build", label: "Sam's build-box" }
const matchFixtures = [adaBox, samBox, buildBox, { id: "mail", label: "Mailbox" }]

test("matchComputers prefers an exact label and ignores case and surrounding spaces", () => {
  assert.deepEqual(matchComputers("  BUILD box  ", matchFixtures), [buildBox])
})

test("matchComputers returns every containing label or no match without matching partial words", () => {
  assert.deepEqual(matchComputers("box build", matchFixtures), [adaBox, samBox, buildBox])
  assert.deepEqual(matchComputers("ada Box", matchFixtures), [adaBox])
  assert.deepEqual(matchComputers("build cloud", matchFixtures), [])
  assert.deepEqual(matchComputers("mail", matchFixtures), [])
  assert.deepEqual(matchComputers("  ", matchFixtures), [])
})

test("matchComputers leaves duplicate exact labels for the caller to disambiguate", () => {
  const duplicate = { id: "another", label: "build Box" }
  assert.deepEqual(matchComputers("build box", [...matchFixtures, duplicate]), [buildBox, duplicate])
})

test("cwd matches equal folders or descendants, never parents, siblings or partial segments", () => {
  const secondFolder: ComputerGrant = { ...workbot, scope: { surface: "sandbox", folders: ["/alt", "/a/logs"] } }
  for (const cwd of ["/a/logs", "/a/logs/current", "/a/logs/runs/today", "/a/logs/.hidden", "/alt/run"]) {
    assert.deepEqual(decide(source, target, { ...action, cwd }, policy([secondFolder])), checked(secondFolder), cwd)
  }
  for (const cwd of ["/a", "/a/logs2", "/a/Logs", "/other/reports", "/a/logs2/today"]) {
    assert.deepEqual(decide(source, target, { ...action, cwd }, policy()), {
      outcome: "refuse", layer: "source", code: "folder_not_shared", changeableBy: "computer_owner",
      message: "The folder I need on Ada's MacBook isn't shared with me. Its owner decides which folders to share.",
    }, cwd)
  }
})

test("an empty folder list permits the sandbox but no explicit cwd", () => {
  const sandboxOnly: ComputerGrant = { ...workbot, scope: { surface: "sandbox", folders: [] } }
  assert.deepEqual(decide(source, target, action, policy([sandboxOnly])), checked(sandboxOnly))
  const decision = decide(source, target, { ...action, cwd: "/a" }, policy([sandboxOnly]))
  assert.equal(decision.outcome === "refuse" && decision.code, "folder_not_shared")
})

test("same-computer decisions use IDs and skip all layers", () => {
  const sameId: Computer = { ...source, label: "Same computer", availability: "offline" }
  const denied: ComputerPolicy = { organization: { allowed: false, requireSandboxOnPersonal: true }, owner: { choice: null }, grants: [] }
  assert.deepEqual(decide(source, sameId, { ...action, cwd: "/unshared" }, denied), { outcome: "allow", route: "direct", scope: null })
})

function freeze<T extends object>(value: T): T {
  Object.freeze(value)
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object" && !Object.isFrozen(child)) freeze(child)
  }
  return value
}

test("decide is deterministic and does not mutate deeply frozen inputs", () => {
  const inputs = { source, target, action: { ...action, cwd: "/exact/child" }, policy: policy([workbot, exact]) }
  const frozen = freeze(structuredClone(inputs))
  const first = decide(frozen.source, frozen.target, frozen.action, frozen.policy)
  assert.deepEqual(first, checked(exact))
  assert.deepEqual(decide(frozen.source, frozen.target, frozen.action, frozen.policy), first)
  assert.deepEqual(frozen, inputs)
})

test("execute refuses before checking availability and never runs refused work", async ({ mock }) => {
  const offline: Computer = { ...target, availability: "offline" }
  const run = mock.fn(async () => assert.fail("refused work must not run"))
  const computers = createComputers({ self: source, computers: [offline], policyFor: () => policy([]), run })
  assert.deepEqual(await computers.execute(offline, action), {
    state: "refused", layer: sourceRefusal.layer, code: sourceRefusal.code,
    message: sourceRefusal.message, changeableBy: sourceRefusal.changeableBy,
  })
  assert.equal(run.mock.callCount(), 0)
})

test("execute does not run on member machines that do not report online", async ({ mock }) => {
  const run = mock.fn(async () => assert.fail("offline work must not run"))
  const computers = createComputers({ self: source, computers: [target], policyFor: () => policy(), run })
  for (const availability of ["offline", "paused", "unknown", "needs_setup"] as const) {
    assert.deepEqual(await computers.execute({ ...target, availability }, action), {
      state: "offline", message: "Ada's MacBook is offline. Try again when it is back online.", retryable: true,
    })
  }
  assert.equal(run.mock.callCount(), 0)
})

test("execute delegates allowed work at every cloud availability", async ({ mock }) => {
  const done: ComputerExecution = { state: "done", id: "command", exitCode: 0, output: "", truncated: false }
  type Request = Parameters<Parameters<typeof createComputers>[0]["run"]>[0]
  const app = signedInApp("ada")
  const workbotCloud = { ...target, kind: "cloud_sandbox", provider: "workbot" } satisfies Computer
  const vm = { ...target, kind: "registered_vm", provider: "daytona" } satisfies Computer
  const vmGrant: ComputerGrant = { ...owner, scope: { surface: "whole_vm", folders: ["/workspace"] } }
  const run = mock.fn(async (_request: Request) => done)
  for (const [self, computer, grant] of [[source, workbotCloud, workbot], [app, vm, vmGrant]] as const) {
    const computers = createComputers({ self, computers: [computer], policyFor: () => policy([grant]), run })
    for (const availability of REMOTE_DEVICE_AVAILABILITIES) {
      const target = { ...computer, availability }
      assert.deepEqual(await computers.execute(target, action), done, `${computer.kind}/${availability}`)
      assert.deepEqual(run.mock.calls.at(-1)?.arguments, [{ source: self, target, action, scope: grant.scope }])
    }
  }
})

test("execute reports same-computer execution unsupported without loading policy or running", async ({ mock }) => {
  const run = mock.fn(async () => assert.fail("direct work must not run remotely"))
  const policyFor = mock.fn(() => assert.fail("direct work needs no policy"))
  const computers = createComputers({ self: source, computers: [source], policyFor, run })
  assert.deepEqual(await computers.execute(source, action), {
    state: "unsupported", message: "Use this chat's own tools to work on this computer.",
  })
  assert.equal(run.mock.callCount(), 0)
  assert.equal(policyFor.mock.callCount(), 0)
})

test("list and decide use supplied snapshots; execute runs once with only the winning grant's scope", async ({ mock }) => {
  const done: ComputerExecution = { state: "done", id: "command", exitCode: 0, output: "", truncated: false }
  type Request = Parameters<Parameters<typeof createComputers>[0]["run"]>[0]
  const run = mock.fn(async (_request: Request) => done)
  const policyFor = mock.fn((_target: Computer) => policy([workbot, exact]))
  const computers = createComputers({ self: source, computers: [source, target], policyFor, run })
  assert.deepEqual(computers.list(), [source, target])
  assert.deepEqual(computers.decide({ ...source, id: "other-chat" }, target, action), checked(workbot))
  assert.deepEqual(await computers.execute(target, action), done)
  assert.equal(run.mock.callCount(), 1)
  assert.deepEqual(run.mock.calls.map((call) => call.arguments), [[{ source, target, action, scope: exact.scope }]])
  assert.deepEqual(policyFor.mock.calls.map((call) => call.arguments), [[target], [target]])
})
