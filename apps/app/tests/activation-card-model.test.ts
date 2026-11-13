import { expect, test } from "bun:test"
import { QueryClient } from "@tanstack/react-query"
import { createActivationCache } from "../src/react-app/domains/cloud/activation/activation-cache"
import type { ActivationState } from "@openwork/types/den/activation"
import {
  activationCardModel,
  activationHiddenStorageKey,
  createActivationReporter,
  draftUsesSkill,
  hasDeviceConnection,
  hasVerifiedDeviceProvider,
  shouldReportActivationEvent,
} from "../src/react-app/domains/cloud/activation/activation-model"

const ids = ["first_response", "invite_teammate", "use_skill", "own_provider", "gateway_provider", "connector"] as const

function state(done: readonly (typeof ids)[number][], extra: Partial<ActivationState> = {}, locked: Partial<Record<(typeof ids)[number], string>> = {}): ActivationState {
  return {
    steps: ids.map((id) => ({ id, done: done.includes(id), ...(locked[id] ? { lockedReason: locked[id] } : {}) })),
    dismissed: false,
    ...extra,
  }
}

test("activation cache reads and writes only the verified principal, not another member in the same organization", () => {
  const client = new QueryClient()
  const cache = createActivationCache(() => client)
  const scope = {}
  const first = ["den-activation", "https://den.example", "org_a", 1, "member_a"]
  const other = ["den-activation", "https://den.example", "org_a", 1, "member_b"]
  const untouched = state([])
  client.setQueryData(first, state(["first_response"]))
  client.setQueryData(other, untouched)
  const unbind = cache.bind(scope, first)
  expect(cache.read(scope)).toEqual(state(["first_response"]))
  cache.write(scope, state(["first_response", "use_skill"]))
  expect(client.getQueryData(first)).toEqual(state(["first_response", "use_skill"]))
  expect(client.getQueryData(other)).toEqual(untouched)
  expect(cache.read({})).toBeUndefined()
  unbind()
  cache.write(scope, state([...ids]))
  expect(cache.read(scope)).toBeUndefined()
  expect(client.getQueryData(first)).toEqual(state(["first_response", "use_skill"]))
  expect(client.getQueryData(other)).toEqual(untouched)
  cache.bind(scope, other)
  cache.write(scope, state([...ids]), first)
  expect(cache.read(scope)).toEqual(untouched)
  unbind() // A stale subscriber cannot remove the new principal's binding.
  expect(cache.read(scope)).toEqual(untouched)
  client.clear()
})

test("the card stays hidden before the first answer, while off, and at six of six", () => {
  expect(activationCardModel(null).presentation).toBe("hidden")
  expect(activationCardModel(undefined).presentation).toBe("hidden")
  expect(activationCardModel(state([])).presentation).toBe("hidden")
  expect(activationCardModel(state([...ids])).presentation).toBe("hidden")
})

test("after the first answer the card shows 1 of 6 and the next step; hiding leaves one Next line", () => {
  const model = activationCardModel(state(["first_response"]))
  expect(model).toMatchObject({ presentation: "full", done: 1, total: 6, next: "Invite a teammate", dismissed: false })
  if (model.presentation === "hidden") throw new Error("expected the card")
  expect(model.rows.map((row) => [row.id, row.state, row.action?.label ?? null])).toEqual([
    ["first_response", "done", null],
    ["invite_teammate", "open", "Invite"],
    ["use_skill", "open", "Try a skill"],
    ["own_provider", "open", "Add key"],
    ["gateway_provider", "open", "Share"],
    ["connector", "open", "Connect"],
  ])
  expect(activationCardModel(state(["first_response"], { dismissed: true }))).toMatchObject({ presentation: "next", next: "Invite a teammate" })
})

test("a member sees locked rows with who can do them and no action", () => {
  const model = activationCardModel(state(["first_response", "invite_teammate"], {}, { gateway_provider: "Avery Owner manages AI Gateway" }))
  if (model.presentation === "hidden") throw new Error("expected the card")
  const gateway = model.rows.find((row) => row.id === "gateway_provider")
  expect(gateway).toEqual({ id: "gateway_provider", title: "Share a provider on AI Gateway", state: "locked", line: "Avery Owner manages AI Gateway", action: null })
  expect(model.next).toBe("Use a skill")
})

test("steps are reported only while Den shows the checklist and the step is open", () => {
  expect(shouldReportActivationEvent(null, "first_response")).toBe(false)
  expect(shouldReportActivationEvent(state([]), "first_response")).toBe(true)
  expect(shouldReportActivationEvent(state(["first_response"]), "first_response")).toBe(false)
  expect(shouldReportActivationEvent(state([]), "dismiss")).toBe(true)
  expect(shouldReportActivationEvent(state([], { dismissed: true }), "dismiss")).toBe(false)
  expect(draftUsesSkill([{ type: "text" }, { type: "skill" }])).toBe(true)
  expect(draftUsesSkill([{ type: "connect-skill" }])).toBe(true)
  expect(draftUsesSkill([{ type: "text" }])).toBe(false)
})

test("the reporter sends one event per step at a time, per organization, and swallows failures", async () => {
  const states = new Map<string, ActivationState | null>([["org_a", state([])], ["org_b", state([])], ["org_off", null]])
  const sent: string[] = []
  let fail = false
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  const report = createActivationReporter<{ key: string }>({
    readState: (scope) => states.get(scope.key),
    send: async (scope, step) => {
      sent.push(`${scope.key}:${step}`)
      await gate
      if (fail) throw new Error("offline")
      return state(["first_response"])
    },
    onState: (scope, next) => { states.set(scope.key, next) },
  })
  const first = report({ key: "org_a" }, "first_response", 2100)
  const duplicate = report({ key: "org_a" }, "first_response", 2100)
  const other = report({ key: "org_b" }, "first_response")
  expect(await report({ key: "org_off" }, "first_response")).toBe(false)
  release()
  expect(await Promise.all([first, duplicate, other])).toEqual([true, false, true])
  expect(sent).toEqual(["org_a:first_response", "org_b:first_response"])
  // Den now counts it: nothing more is sent for this organization.
  expect(await report({ key: "org_a" }, "first_response")).toBe(false)
  fail = true
  expect(await report({ key: "org_a" }, "use_skill")).toBe(false)
  expect(sent).toEqual(["org_a:first_response", "org_b:first_response", "org_a:use_skill"])
})

test("Hide setup removes the card entirely, even after Den counts it dismissed", () => {
  expect(activationCardModel(state(["first_response"]), { hidden: true })).toEqual({ presentation: "hidden" })
  expect(activationCardModel(state(["first_response"], { dismissed: true }), { hidden: true })).toEqual({ presentation: "hidden" })
  expect(activationCardModel(state(["first_response"]), { hidden: false })).toMatchObject({ presentation: "full" })
  const key = (principalId: string, organizationId = "org_a") => activationHiddenStorageKey({ origin: "https://den.example", organizationId, principalId })
  expect(key("member_a")).not.toBe(key("member_b"))
  expect(key("member_a")).not.toBe(key("member_a", "org_b"))
})

test("an optional step keeps its row and action, is not counted, and is never next", () => {
  const alone: ActivationState = {
    steps: ids.map((id) => ({ id, done: id !== "invite_teammate" && id !== "connector", ...(id === "invite_teammate" ? { optional: true } : {}) })),
    dismissed: false,
  }
  const model = activationCardModel(alone)
  expect(model).toMatchObject({ presentation: "full", done: 4, total: 5, next: "Connect an app" })
  if (model.presentation === "hidden") throw new Error("expected a card")
  expect(model.rows[1]).toEqual({ id: "invite_teammate", title: "Invite a teammate", state: "open", line: "Optional while you work alone", action: { kind: "invite", label: "Invite" } })
  // Everything that applies is done: nothing left to show.
  const finished: ActivationState = { ...alone, steps: alone.steps.map((step) => (step.id === "connector" ? { ...step, done: true } : step)) }
  expect(activationCardModel(finished).presentation).toBe("hidden")
  // Without the marker (an older Den, or the feature off) the same step counts as before.
  expect(activationCardModel(state(["first_response", "use_skill", "own_provider", "gateway_provider"]))).toMatchObject({ done: 4, total: 6, next: "Invite a teammate" })
})

test("a provider counts as working on this device only after it served an answer here and is the person's own", () => {
  const managed = (id: string) => id.startsWith("lpr_") || id === "openwork" || id === "openwork-free"
  const key = (workspace: string, provider: string) => JSON.stringify([workspace, provider])
  const scopes = { local: "device", remote: "https://worker.example" }
  const verified = { status: "verified" }
  expect(hasVerifiedDeviceProvider({ entries: { [key("local", "opencode-go")]: verified }, workspaceScopes: scopes }, managed)).toBe(true)
  expect(hasVerifiedDeviceProvider({ entries: {}, workspaceScopes: scopes }, managed)).toBe(false)
  // Rejected or never used: not working.
  expect(hasVerifiedDeviceProvider({ entries: { [key("local", "anthropic")]: { status: "rejected" } }, workspaceScopes: scopes }, managed)).toBe(false)
  // The organization's or OpenWork's models, and the engine's built-in ones, are not the person's own setup.
  for (const provider of ["lpr_123", "openwork", "openwork-free", "opencode"]) {
    expect(hasVerifiedDeviceProvider({ entries: { [key("local", provider)]: verified }, workspaceScopes: scopes }, managed)).toBe(false)
  }
  // A remote workspace's provider is not on this device; an unknown workspace proves nothing.
  expect(hasVerifiedDeviceProvider({ entries: { [key("remote", "anthropic")]: verified }, workspaceScopes: scopes }, managed)).toBe(false)
  expect(hasVerifiedDeviceProvider({ entries: { [key("gone", "anthropic")]: verified, "not json": verified, '"text"': verified }, workspaceScopes: scopes }, managed)).toBe(false)
})

test("a connection counts on this device only when the engine reports the person's own one connected", () => {
  expect(hasDeviceConnection({ linear: { status: "connected" } })).toBe(true)
  expect(hasDeviceConnection({ linear: { status: "needs_auth" }, notion: { status: "failed" }, github: { status: "disabled" } })).toBe(false)
  // Organization connections are Den's to count.
  expect(hasDeviceConnection({ "openwork-cloud": { status: "connected" }, "openwork-direct-slack-c1ca24": { status: "connected" } })).toBe(false)
  expect(hasDeviceConnection({})).toBe(false)
  expect(hasDeviceConnection(null)).toBe(false)
})

test("a device connection is reported once while its step is open, and never once Den counts it", async () => {
  const sent: string[] = []
  let current: ActivationState | null = state(["first_response"])
  const report = createActivationReporter<{ key: string }>({
    readState: () => current,
    send: async (_scope, step) => { sent.push(step); return state(["first_response", "connector"]) },
    onState: (_scope, next) => { current = next },
  })
  expect(await Promise.all([report({ key: "a" }, "connector"), report({ key: "a" }, "connector")])).toEqual([true, false])
  expect(await report({ key: "a" }, "connector")).toBe(false)
  expect(sent).toEqual(["connector"])
  current = null
  expect(await report({ key: "a" }, "connector")).toBe(false)
})
