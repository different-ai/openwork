import assert from "node:assert/strict"
import { test } from "node:test"
import {
  COMPUTER_COMMAND_PICKUP_MS,
  COMPUTER_EXECUTABLE_VM_PROVIDERS,
  COMPUTER_OUTPUT_MAX_BYTES,
  COMPUTER_TOOL_CALL_MAX_BYTES,
  COMPUTER_TOOL_NAMES,
  COMPUTER_STATE_LABELS,
  COMPUTER_STATES,
  computerAccessReportSchema,
  computerAccessSettingSchema,
  computerActionSchema,
  computerAuthorizeRequestSchema,
  computerAuthorizeResponseSchema,
  computerCommandAssignmentSchema,
  computerCommandCompleteRequestSchema,
  computerDecisionSchema,
  computerExecutionSchema,
  computerFolderSchema,
  computerGrantScopeSchema,
  computerListResponseSchema,
  computerRunnerAccessResponseSchema,
  computerSourceCommandRequestSchema,
  computerSourceListResponseSchema,
  computerSourceRefSchema,
  computerToolCallFits,
  computerToolCallSchema,
  isExecutableVmProvider,
  listedComputerSchema,
} from "@openwork/types/den/computers"
import { computerRunCodeSchema, computerSourceAccessSchema } from "@openwork/types/den/computer-inventory"
import { DEFAULT_COMPUTER_SHARING_SETTINGS, computerSharingSettingsSchema, computerSharingStateSchema } from "@openwork/types/computer-sharing"

const scope = { surface: "sandbox", folders: ["/a/logs"] }

function numberedFolders(count: number) {
  return Array.from({ length: count }, (_, index) => `/logs/${index}`)
}

test("sandbox grants accept up to 32 unique folders", () => {
  assert.deepEqual(computerGrantScopeSchema.parse(scope), scope)
  assert.equal(computerGrantScopeSchema.safeParse({ surface: "sandbox", folders: [] }).success, true)
  assert.equal(computerGrantScopeSchema.safeParse({ surface: "sandbox", folders: numberedFolders(32) }).success, true)
  for (const surface of ["whole_machine", "host", "", null, undefined]) {
    assert.equal(computerGrantScopeSchema.safeParse({ ...scope, surface }).success, false)
  }
  assert.equal(computerGrantScopeSchema.safeParse({ ...scope, wholeMachine: true }).success, false)
  assert.equal(computerGrantScopeSchema.safeParse({ ...scope, folders: ["/a/logs", "/a/logs"] }).success, false)
  assert.equal(computerGrantScopeSchema.safeParse({ ...scope, folders: numberedFolders(33) }).success, false)
})

test("sandbox writable folders must be unique and explicitly shared in both scopes and access reports", () => {
  const source = { kind: "workbot" }
  const writableFolders = ["/a/logs"]
  const editable = { ...scope, writableFolders }
  const report = { choice: "allow", grants: [{ source, folders: scope.folders, writableFolders }] }
  assert.deepEqual(computerGrantScopeSchema.parse(editable), editable)
  const allowance = { outcome: "allow", route: "checked", scope: editable }
  assert.deepEqual(computerDecisionSchema.parse(allowance), allowance)
  assert.deepEqual(computerAccessReportSchema.parse(report), report)
  for (const invalid of [["/other"], ["/a/logs/child"], ["/a/logs", "/a/logs"], ["a/logs"]]) {
    assert.equal(computerGrantScopeSchema.safeParse({ ...editable, writableFolders: invalid }).success, false)
    assert.equal(computerAccessReportSchema.safeParse({ ...report, grants: [{ ...report.grants[0], writableFolders: invalid }] }).success, false)
  }
})

test("folder paths are bounded absolute POSIX paths with no ambiguous segments", () => {
  for (const path of ["/a", "/a/logs", "/a/my logs", "/a/.hidden", "/a/logs..", "/" + "x".repeat(1023)]) {
    assert.equal(computerFolderSchema.parse(path), path)
  }
  for (const path of [
    "", "logs", "C:/logs", "/", "/a/", "//a", "/a//logs", "/.", "/..", "/a/.", "/a/..", "/a/./logs", "/a/../logs",
    "/a\\logs", "/a\0", "/a\n", "/a\t", "/a\u007f", "/a\u0085", "/" + "x".repeat(1024),
  ]) {
    assert.equal(computerFolderSchema.safeParse(path).success, false, JSON.stringify(path))
  }
})

test("shell actions enforce command length, timeout bounds and folder rules", () => {
  const shell = { type: "shell", command: "true" }
  assert.deepEqual(computerActionSchema.parse(shell), shell)
  assert.equal(computerActionSchema.safeParse({ ...shell, command: "x", cwd: "/a", timeoutMs: 1 }).success, true)
  assert.equal(computerActionSchema.safeParse({ ...shell, command: "x".repeat(32_000), timeoutMs: 120_000 }).success, true)
  for (const fields of [
    { command: "" }, { command: "x".repeat(32_001) }, { timeoutMs: 0 }, { timeoutMs: 120_001 }, { timeoutMs: 2.5 },
    { cwd: "/a/../logs" }, { cwd: "/" }, { type: "other" },
  ]) {
    assert.equal(computerActionSchema.safeParse({ ...shell, ...fields }).success, false)
  }
})

test("file actions use the same canonical folder paths; only lists and searches can omit the path", () => {
  for (const type of ["read", "write", "list", "search"]) {
    const action = { type, path: "/workspace/src/index.ts" }
    assert.deepEqual(computerActionSchema.parse(action), action)
    assert.equal(computerActionSchema.safeParse({ type }).success, type === "list" || type === "search")
    for (const path of ["src", "/workspace/../other", "/workspace/", null]) {
      assert.equal(computerActionSchema.safeParse({ type, path }).success, false)
    }
  }
})

const toolCalls = [
  { tool: "shell", input: { command: "true", cwd: "/workspace", timeoutMs: 120_000 } },
  { tool: "read", input: { path: "/workspace/notes", offset: 1, limit: 2_000 } },
  { tool: "write", input: { path: "/workspace/notes", content: "" } },
  { tool: "edit", input: { path: "/workspace/notes", oldString: "old", newString: "", replaceAll: false } },
  { tool: "glob", input: { path: "/workspace", pattern: "**/*.txt", hidden: true, limit: 1 } },
  { tool: "grep", input: { path: "/workspace", pattern: "notes", literal: true, include: "*.txt", caseSensitive: false, limit: 1 } },
]

test("tool calls are strict and all six require a canonical absolute path", () => {
  assert.deepEqual(COMPUTER_TOOL_NAMES, toolCalls.map(({ tool }) => tool))
  for (const call of toolCalls) {
    const pathKey = call.tool === "shell" ? "cwd" : "path"
    assert.deepEqual(computerToolCallSchema.parse(call), call)
    for (const path of [undefined, "workspace", "/workspace/../other"]) {
      assert.equal(computerToolCallSchema.safeParse({ ...call, input: { ...call.input, [pathKey]: path } }).success, false, call.tool)
    }
    assert.equal(computerToolCallSchema.safeParse({ ...call, extra: true }).success, false)
    assert.equal(computerToolCallSchema.safeParse({ ...call, input: { ...call.input, extra: true } }).success, false)
  }
  for (const [call, patch] of [
    [toolCalls[0], { timeoutMs: 120_001 }], [toolCalls[1], { offset: 0 }], [toolCalls[1], { limit: 2_001 }],
    [toolCalls[2], { content: "x".repeat(32_001) }], [toolCalls[3], { oldString: "" }],
    [toolCalls[4], { pattern: "" }], [toolCalls[5], { include: "x".repeat(1_025) }],
  ] as const) {
    assert.equal(computerToolCallSchema.safeParse({ ...call, input: { ...call.input, ...patch } }).success, false)
  }
})

test("tool calls cap serialized UTF-8 bytes, including JSON escaping and keys", () => {
  assert.equal(COMPUTER_TOOL_CALL_MAX_BYTES, 128_000)
  const input = { path: "/workspace/notes", oldString: "é".repeat(32_000), newString: "é".repeat(30_000) }
  const fits = { tool: "edit", input } as const
  const oversized = { ...fits, input: { ...input, newString: "é".repeat(32_000) } }
  const escaped = { tool: "write", input: { path: "/workspace/notes", content: "\u0000".repeat(32_000) } } as const
  assert.equal(computerToolCallFits(fits), true)
  assert.deepEqual(computerToolCallSchema.parse(fits), fits)
  for (const call of [oversized, escaped]) {
    assert.equal(computerToolCallFits(call), false)
    assert.equal(computerToolCallSchema.safeParse(call).success, false)
  }
})

test("owner source refs are strict and parse in existing access reports", () => {
  const source = { kind: "owner" }
  assert.deepEqual(computerSourceRefSchema.parse(source), source)
  assert.equal(computerSourceRefSchema.safeParse({ ...source, id: "ada" }).success, false)
  assert.equal(computerAccessReportSchema.safeParse({ choice: "allow", grants: [{ source, folders: ["/workspace"] }] }).success, true)
})

test("whole-VM consent requires an explicit scope and exactly one canonical working folder", () => {
  const setting = { choice: "allow", scope: "whole_vm", folders: ["/workspace"] }
  assert.deepEqual(computerAccessSettingSchema.parse(setting), setting)
  assert.deepEqual(computerGrantScopeSchema.parse({ surface: "whole_vm", folders: setting.folders }), { surface: "whole_vm", folders: setting.folders })
  assert.deepEqual(computerAccessSettingSchema.parse({ choice: "off" }), { choice: "off" })
  assert.deepEqual(computerAccessSettingSchema.parse({ choice: "off", folders: numberedFolders(8) }), { choice: "off", folders: numberedFolders(8) })
  for (const invalid of [
    { choice: null, folders: [] }, { choice: "allow", folders: ["/workspace"] }, { ...setting, scope: "sandbox" },
    ...[[], ["/workspace", "/data"], ["workspace"]].map((folders) => ({ ...setting, folders })),
  ]) {
    assert.equal(computerAccessSettingSchema.safeParse(invalid).success, false)
  }
  assert.equal(computerAccessReportSchema.safeParse({ choice: "allow", grants: [{ source: { kind: "computer", id: "owner_whole_vm" }, folders: ["/workspace"] }] }).success, false)
})

const reach = { outcome: "allow", route: "checked", scope }
const listed = {
  id: "vm", kind: "registered_vm", provider: "daytona", label: "Build box", ownerMemberId: "ada", availability: "unknown",
  state: "starts_when_needed", lastSeenAt: null, access: { choice: null, folders: [] }, reach,
}

test("listed computers include a known state, an ISO last-seen time or null, access and reach", () => {
  assert.deepEqual(COMPUTER_STATES, ["ready", "starts_when_needed", "has_a_problem", "online", "offline"])
  assert.deepEqual(COMPUTER_STATE_LABELS, {
    ready: "Ready", starts_when_needed: "Starts when needed", has_a_problem: "Has a problem", online: "Online", offline: "Offline",
  })
  assert.deepEqual(listedComputerSchema.parse(listed), listed)
  const seen = { ...listed, access: null, lastSeenAt: "2026-11-26T18:00:00Z" }
  assert.deepEqual(computerListResponseSchema.parse({ computers: [seen, listed] }), { computers: [seen, listed] })
  assert.equal(listedComputerSchema.safeParse({ ...listed, state: "unknown" }).success, false)
  assert.equal(listedComputerSchema.safeParse({ ...listed, lastSeenAt: "today" }).success, false)
  assert.equal(listedComputerSchema.safeParse({ ...listed, access: { choice: true, folders: [] } }).success, false)
  assert.equal(listedComputerSchema.safeParse({ ...listed, reach: null }).success, false)
})

test("authorize accepts a strict action body and returns the decision, computer and nullable connection", () => {
  const request = { action: { type: "read", path: "/workspace" } }
  assert.deepEqual(computerAuthorizeRequestSchema.parse(request), request)
  assert.equal(computerAuthorizeRequestSchema.safeParse({ ...request, extra: true }).success, false)
  assert.equal(computerAuthorizeRequestSchema.safeParse({ action: { type: "read" } }).success, false)
  const connection = { provider: "daytona", externalId: "sandbox" }
  const allowed = { decision: reach, computer: listed, connection }
  assert.deepEqual(computerAuthorizeResponseSchema.parse(allowed), allowed)
  assert.equal(computerAuthorizeResponseSchema.safeParse({ ...allowed, connection: { ...connection, provider: "invalid-provider" } }).success, false)
  const decision = { outcome: "refuse", layer: "source", code: "nothing_shared", message: "Nothing is shared.", changeableBy: "computer_owner" }
  const refused = { decision, computer: { ...listed, reach: decision }, connection: null }
  assert.deepEqual(computerAuthorizeResponseSchema.parse(refused), refused)
})

test("access reports are strict and cap grants and folders", () => {
  const source = { kind: "workbot" }
  const entry = { source, folders: numberedFolders(32) }
  const report = { choice: "allow", grants: [entry] }
  const grants = Array.from({ length: 16 }, (_, id) => ({ ...entry, source: { kind: "computer", id: String(id) } }))
  for (const choice of ["allow", "off", null]) {
    assert.deepEqual(computerAccessReportSchema.parse({ choice, grants }), { choice, grants })
  }
  assert.deepEqual(computerAccessReportSchema.parse(report), report)
  assert.deepEqual(computerAccessReportSchema.parse({ choice: null, grants: [] }), { choice: null, grants: [] })
  for (const changes of [
    { choice: true }, { extra: true }, { grants: [...grants, entry] }, { grants: [{ ...entry, folders: numberedFolders(33) }] },
    { grants: [{ source, folders: ["/logs", "/logs"] }] }, { grants: [{ source, folders: ["/"] }] },
    { grants: [{ ...entry, surface: "host" }] }, { grants: [{ ...entry, source: { kind: "computer" } }] },
  ]) {
    assert.equal(computerAccessReportSchema.safeParse({ ...report, ...changes }).success, false)
  }
})

test("only a direct allowance can have a null scope", () => {
  assert.equal(computerDecisionSchema.safeParse({ outcome: "allow", route: "direct", scope: null }).success, true)
  assert.equal(computerDecisionSchema.safeParse({ outcome: "allow", route: "checked", scope }).success, true)
  assert.equal(computerDecisionSchema.safeParse({ outcome: "allow", route: "direct", scope }).success, false)
  assert.equal(computerDecisionSchema.safeParse({ outcome: "allow", route: "checked", scope: null }).success, false)
})

test("non-changeable computer refusals and unknown command outcomes keep their structured fields", () => {
  for (const [layer, code, message] of [
    ["computer", "not_available_yet", "Build box can't take work from other computers yet."],
    ["source", "owner_app_only", "Build box only takes work from its owner's own OpenWork apps."],
  ]) {
    const fields = { layer, code, changeableBy: "no_one", message }
    const decision = { outcome: "refuse", ...fields }
    const execution = { state: "refused", ...fields }
    assert.deepEqual(computerDecisionSchema.parse(decision), decision)
    assert.deepEqual(computerExecutionSchema.parse(execution), execution)
  }
  const unknown = { state: "unknown", id: "queued-command", message: "Build box hasn't reported back. It may have run." }
  assert.deepEqual(computerExecutionSchema.parse(unknown), unknown)
  assert.equal(computerExecutionSchema.safeParse({ ...unknown, id: undefined }).success, false)
  assert.equal(computerExecutionSchema.safeParse({ ...unknown, message: undefined }).success, false)
})

test("command completion caps UTF-8 bytes, not just string length", () => {
  const done = { status: "done", exitCode: 0, truncated: false }
  for (const output of ["", "x".repeat(COMPUTER_OUTPUT_MAX_BYTES), "é".repeat(COMPUTER_OUTPUT_MAX_BYTES / 2)]) {
    assert.equal(computerCommandCompleteRequestSchema.safeParse({ ...done, output }).success, true)
  }
  for (const output of ["x".repeat(COMPUTER_OUTPUT_MAX_BYTES + 1), "é".repeat(COMPUTER_OUTPUT_MAX_BYTES / 2) + "x"]) {
    assert.equal(computerCommandCompleteRequestSchema.safeParse({ ...done, output }).success, false)
  }
})

test("offline executions parse older payloads, null and ISO last contact but not arbitrary dates", () => {
  const offline = { state: "offline", message: "Build box is offline.", retryable: true }
  for (const lastSeenAt of [null, "2026-11-26T18:00:00Z", "2026-11-26T10:00:00-08:00"]) {
    assert.deepEqual(computerExecutionSchema.parse({ ...offline, lastSeenAt }), { ...offline, lastSeenAt })
  }
  assert.deepEqual(computerExecutionSchema.parse(offline), { ...offline, lastSeenAt: null })
  assert.equal(computerExecutionSchema.safeParse({ ...offline, lastSeenAt: "yesterday" }).success, false)
})

test("source and runner contracts carry the tool call, share permissions and pickup deadline", () => {
  assert.equal(COMPUTER_COMMAND_PICKUP_MS, 30_000)
  const call = toolCalls[0]
  assert.deepEqual(computerSourceCommandRequestSchema.parse({ call }), { call, waitMs: 15_000 })
  for (const waitMs of [0, 20_000]) assert.deepEqual(computerSourceCommandRequestSchema.parse({ call, waitMs }), { call, waitMs })
  for (const waitMs of [-1, 20_001, 0.5, "100"]) assert.equal(computerSourceCommandRequestSchema.safeParse({ call, waitMs }).success, false)
  assert.equal(computerSourceCommandRequestSchema.safeParse({ call, action: { type: "read", path: "/workspace" } }).success, false)
  const self = { id: "studio", provider: "openwork_desktop", kind: "member_machine", label: "Studio Mac", ownerMemberId: "ada", availability: "online" }
  for (const source of [null, self]) {
    const listing = { self: source, computers: [listed] }
    assert.deepEqual(computerSourceListResponseSchema.parse(listing), listing)
  }
  const writableFolders = scope.folders
  const assignment = { id: "command", source: self, scope: { ...scope, writableFolders }, action: { type: "shell", command: "true", cwd: "/workspace" }, expiresAt: "2026-11-26T18:00:00Z" }
  assert.deepEqual(computerCommandAssignmentSchema.parse(assignment), assignment)
  assert.deepEqual(computerCommandAssignmentSchema.parse({ ...assignment, call }), { ...assignment, call })
  const access = { organizationAllows: true, choice: null, grants: [{ source: { kind: "workbot" }, folders: scope.folders, writableFolders, revokedAt: null }] }
  assert.deepEqual(computerRunnerAccessResponseSchema.parse(access), access)
  assert.equal(computerRunnerAccessResponseSchema.safeParse({ ...access, organizationAllows: null }).success, false)
})

test("only Daytona and Freestyle are executable VM providers; inventory accepts new off reasons and old grants", () => {
  assert.deepEqual(COMPUTER_EXECUTABLE_VM_PROVIDERS, ["daytona", "freestyle"])
  for (const provider of ["daytona", "freestyle", "workbot", "openwork_desktop", "other", null]) {
    assert.equal(isExecutableVmProvider(provider), provider === "daytona" || provider === "freestyle")
  }
  for (const reason of ["sandbox_unavailable", "nothing_shared"]) {
    assert.deepEqual(computerRunCodeSchema.parse({ value: "no", reason }), { value: "no", reason })
  }
  const source = { key: "workbot", label: "Workbot", scope: "sandbox", folders: ["/workspace"], revokedAt: null, revokedBy: null }
  assert.deepEqual(computerSourceAccessSchema.parse(source), { ...source, writableFolders: [] })
})

test("sharing settings default to off and accept only unique folders and personal sources", () => {
  assert.deepEqual(DEFAULT_COMPUTER_SHARING_SETTINGS, { enabled: false, folders: [], sources: [] })
  assert.deepEqual(computerSharingSettingsSchema.parse(DEFAULT_COMPUTER_SHARING_SETTINGS), DEFAULT_COMPUTER_SHARING_SETTINGS)
  const folder = { path: "/workspace", access: "read" }
  const workbot = { kind: "workbot" }
  const desktop = { kind: "computer", id: "workbot" }
  const settings = { enabled: true, folders: [folder], sources: [desktop, workbot] }
  assert.deepEqual(computerSharingSettingsSchema.parse(settings), settings)
  for (const invalid of [
    { extra: true }, { folders: [folder, { ...folder, access: "edit" }] }, { folders: [{ ...folder, path: "workspace" }] },
    { folders: [{ ...folder, extra: true }] },
    { folders: numberedFolders(33).map((path) => ({ ...folder, path })) }, { sources: [workbot, workbot] },
    { sources: [desktop, desktop] }, { sources: [{ kind: "owner" }] }, { sources: [{ ...workbot, id: "other" }] },
    { sources: Array.from({ length: 17 }, (_, id) => ({ kind: "computer", id: String(id) })) },
  ]) {
    assert.equal(computerSharingSettingsSchema.safeParse({ ...settings, ...invalid }).success, false)
  }
  const state = {
    settings, availability: { state: "unavailable", reason: "signed_out", message: "Sign in to take work from another computer." },
    organizationAllows: null, revokedSources: [{ source: workbot, revokedAt: "2026-11-26T18:00:00Z" }], sync: "pending",
  }
  assert.deepEqual(computerSharingStateSchema.parse(state), state)
  assert.equal(computerSharingStateSchema.safeParse({ ...state, availability: { state: "unavailable", reason: "signed_out" } }).success, false)
})

test("failed command completion has a bounded snake_case code and message", () => {
  const valid = { code: "runner_failed", message: "x".repeat(300) }
  assert.equal(computerCommandCompleteRequestSchema.safeParse({ status: "failed", error: valid }).success, true)
  for (const error of [
    { ...valid, code: "runner-failed" }, { ...valid, code: "RunnerFailed" }, { ...valid, code: "x".repeat(65) },
    { ...valid, message: "x".repeat(301) },
  ]) {
    assert.equal(computerCommandCompleteRequestSchema.safeParse({ status: "failed", error }).success, false)
  }
})
