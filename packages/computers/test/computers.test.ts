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
  assert.deepEqual(refusal("organization_off", target, action), {
    outcome: "refuse", layer: "organization", code: "organization_off", changeableBy: "organization_admin",
    message: "I can't do that. Your admin has turned this off for the organization.",
  })
  assert.deepEqual(refusal("computer_not_allowed", target, action), {
    outcome: "refuse", layer: "computer", code: "computer_not_allowed", changeableBy: "computer_owner",
    message: "I can't do that. Ada's MacBook doesn't take work from other computers. Its owner can allow it in Settings > Devices on that computer.",
  })
  assert.deepEqual(refusal("nothing_shared", target, action), {
    outcome: "refuse", layer: "source", code: "nothing_shared", changeableBy: "computer_owner",
    message: "I can't use Ada's MacBook. Nothing on it is shared with me. Its owner can share its sandbox and folders in Settings > Devices on that computer.",
  })
  assert.deepEqual(refusal("folder_not_shared", target, { ...action, cwd: "/home/ada/logs" }), {
    outcome: "refuse", layer: "source", code: "folder_not_shared", changeableBy: "computer_owner",
    message: "I can't see the logs folder on Ada's MacBook. It isn't shared with me. Its owner can share it in Settings > Devices on that computer.",
  })
})

test("a folder refusal without a stored working directory still describes the requested folder", () => {
  assert.equal(refusal("folder_not_shared", target, action).message,
    "I can't see the requested folder on Ada's MacBook. It isn't shared with me. Its owner can share it in Settings > Devices on that computer.")
})
const workbot: ComputerGrant = { source: { kind: "workbot" }, targetId: target.id, scope: { surface: "sandbox", folders: ["/a/logs"] } }
const exact: ComputerGrant = { source: { kind: "computer", id: source.id }, targetId: target.id, scope: { surface: "sandbox", folders: ["/exact"] } }

function policy(grants: ComputerGrant[] = [workbot]): ComputerPolicy {
  return { organization: { allowed: true }, owner: { choice: "allow" }, grants }
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
  message: "I can't do that. Ada's MacBook doesn't take work from other computers. Its owner can allow it in Settings > Devices on that computer.",
}
const sourceRefusal = {
  outcome: "refuse", layer: "source", code: "nothing_shared", changeableBy: "computer_owner",
  message: "I can't use Ada's MacBook. Nothing on it is shared with me. Its owner can share its sandbox and folders in Settings > Devices on that computer.",
}

for (const allowed of [false, true]) {
  for (const choice of [null, "off", "allow"] as const) {
    for (const shared of [false, true]) {
      test(`decision: organization allowed=${allowed}, owner=${choice}, source shared=${shared}`, () => {
        const snapshot: ComputerPolicy = { organization: { allowed }, owner: { choice }, grants: shared ? [workbot] : [] }
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
      message: "I can't see the logs folder on Ada's MacBook. It isn't shared with me. Its owner can share it in Settings > Devices on that computer.",
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

test("when all grants match, exact wins over owner and owner wins over Workbot without folder fallback", () => {
  const desktop = { ...source, kind: "member_machine" } satisfies Computer
  for (const grants of [[workbot, owner, exact], [exact, owner, workbot]]) {
    assert.deepEqual(decide(desktop, target, action, policy(grants)), checked(exact))
  }
  for (const grants of [[owner, workbot], [workbot, owner]]) {
    assert.deepEqual(decide(desktop, target, action, policy(grants)), checked(owner))
    const read: ComputerAction = { type: "read", path: "/a/logs" }
    assert.deepEqual(decide(desktop, target, read, policy(grants)), refusal("folder_not_shared", target, read))
  }
})

test("reads, writes, lists and searches enforce the same path check and name the refused path", () => {
  const pathTypes: Exclude<ComputerAction["type"], "shell">[] = ["read", "write", "list", "search"]
  for (const type of pathTypes) {
    for (const path of ["/workspace", "/workspace/artifacts"]) {
      assert.deepEqual(decide(signedInApp("ada"), target, { type, path }, policy([owner])), checked(owner))
    }
    const decision = decide(signedInApp("ada"), target, { type, path: "/workspace-other/artifacts" }, policy([owner]))
    assert.deepEqual(decision, {
      outcome: "refuse", layer: "source", code: "folder_not_shared", changeableBy: "computer_owner",
      message: "I can't see the artifacts folder on Ada's MacBook. It isn't shared with me. Its owner can share it in Settings > Devices on that computer.",
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
  for (const [cwd, folder] of [["/a", "a"], ["/a/logs2", "logs2"], ["/a/Logs", "Logs"], ["/other/reports", "reports"], ["/a/logs2/today", "today"]]) {
    assert.deepEqual(decide(source, target, { ...action, cwd }, policy()), {
      outcome: "refuse", layer: "source", code: "folder_not_shared", changeableBy: "computer_owner",
      message: `I can't see the ${folder} folder on Ada's MacBook. It isn't shared with me. Its owner can share it in Settings > Devices on that computer.`,
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
  const denied: ComputerPolicy = { organization: { allowed: false }, owner: { choice: null }, grants: [] }
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

test("execute delegates allowed work to both cloud kinds at every availability", async ({ mock }) => {
  const done: ComputerExecution = { state: "done", id: "command", exitCode: 0, output: "", truncated: false }
  type Request = Parameters<Parameters<typeof createComputers>[0]["run"]>[0]
  const cloudTargets: Computer[] = [
    { ...target, kind: "cloud_sandbox", provider: "workbot" },
    { ...target, kind: "registered_vm", provider: "daytona" },
  ]
  const run = mock.fn(async (_request: Request) => done)
  const computers = createComputers({ self: source, computers: cloudTargets, policyFor: () => policy(), run })
  const targets = cloudTargets.flatMap((computer) => REMOTE_DEVICE_AVAILABILITIES.map((availability) => ({ ...computer, availability })))
  for (const cloud of targets) {
    assert.deepEqual(await computers.execute(cloud, action), done, `${cloud.kind}/${cloud.availability}`)
  }
  assert.deepEqual(run.mock.calls.map((call) => call.arguments), targets.map((target) => [{ source, target, action, scope: workbot.scope }]))
})

test("execute reports same-computer execution unsupported without loading policy or running", async ({ mock }) => {
  const run = mock.fn(async () => assert.fail("direct work must not run remotely"))
  const policyFor = mock.fn(() => assert.fail("direct work needs no policy"))
  const computers = createComputers({ self: source, computers: [source], policyFor, run })
  assert.deepEqual(await computers.execute(source, action), {
    state: "unsupported", message: "A computer runs work in its own sandbox directly, not through another computer.",
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
