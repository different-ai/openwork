import assert from "node:assert/strict"
import { test } from "node:test"
import { activationChecklistPresentation, activationProgress, nextActivationStep, orderedActivationSteps } from "@openwork/types/den/activation"
import { computeActivationState, type ActivationFacts } from "../src/activation-steps.js"

const fresh: ActivationFacts = {
  firstResponse: { done: false, durationMs: null },
  invite: { canInvite: true, invitedByMe: 0, teammates: 0, joined: 1, pending: 0 },
  skillUsed: false,
  ownProvider: { reportedOnDevice: false, addedProviderName: null, orgProvided: false, canConfigure: true },
  gateway: { canManage: true, hasProvider: false, providerName: null },
  readyConnectionName: null,
  ownerName: "Avery Owner",
  dismissed: false,
}

function facts(patch: Partial<ActivationFacts>): ActivationFacts {
  return { ...fresh, ...patch }
}

test("a new owner sees six unchecked steps in recipe order and no checklist before the first answer", () => {
  const state = computeActivationState(fresh)
  assert.deepEqual(state.steps.map((step) => step.id), ["first_response", "invite_teammate", "use_skill", "own_provider", "gateway_provider", "connector"])
  assert.equal(state.steps.every((step) => !step.done && !step.lockedReason), true)
  assert.equal(activationChecklistPresentation(state), "hidden")
  assert.deepEqual(activationProgress(state), { done: 0, total: 6, complete: false })
})

test("the first answer shows the checklist with its timing and points at inviting a teammate", () => {
  const state = computeActivationState(facts({ firstResponse: { done: true, durationMs: 2140 } }))
  assert.equal(state.steps[0]?.detail, "Answered in 2.1 s")
  assert.equal(activationChecklistPresentation(state), "full")
  assert.equal(nextActivationStep(state)?.id, "invite_teammate")
  assert.equal(activationProgress(state).done, 1)
  // Without a recorded duration the step still checks off, with no invented number.
  assert.equal(computeActivationState(facts({ firstResponse: { done: true, durationMs: null } })).steps[0]?.detail, undefined)
})

test("an inviter checks off only after inviting someone; a member counts any teammate and cannot invite", () => {
  const owner = computeActivationState(facts({ invite: { canInvite: true, invitedByMe: 0, teammates: 3, joined: 4, pending: 0 } }))
  assert.equal(owner.steps[1]?.done, false, "teammates the owner did not invite do not count for the owner")
  const invited = computeActivationState(facts({ invite: { canInvite: true, invitedByMe: 1, teammates: 1, joined: 1, pending: 1 } }))
  assert.deepEqual(invited.steps[1], { id: "invite_teammate", done: true, detail: "1 joined, 1 invited" })
  const lonelyMember = computeActivationState(facts({ invite: { canInvite: false, invitedByMe: 0, teammates: 0, joined: 1, pending: 0 } }))
  assert.deepEqual(lonelyMember.steps[1], { id: "invite_teammate", done: false, lockedReason: "Avery Owner can invite people" })
  const member = computeActivationState(facts({ invite: { canInvite: false, invitedByMe: 0, teammates: 2, joined: 3, pending: 0 } }))
  assert.equal(member.steps[1]?.done, true)
})

test("a member sees the AI Gateway step locked with who manages it, and checked once the team shares a provider", () => {
  const locked = computeActivationState(facts({ gateway: { canManage: false, hasProvider: false, providerName: null } }))
  assert.deepEqual(locked.steps[4], { id: "gateway_provider", done: false, lockedReason: "Avery Owner manages AI Gateway" })
  assert.deepEqual(computeActivationState(facts({ gateway: { canManage: false, hasProvider: false, providerName: null }, ownerName: null })).steps[4]?.lockedReason, "Your workspace owner manages AI Gateway")
  const redacted = computeActivationState(facts({ gateway: { canManage: false, hasProvider: true, providerName: null } }))
  assert.deepEqual(redacted.steps[4], { id: "gateway_provider", done: true })
  const shared = computeActivationState(facts({ gateway: { canManage: false, hasProvider: true, providerName: "Team OpenAI" } }))
  assert.deepEqual(shared.steps[4], { id: "gateway_provider", done: true, detail: "Team OpenAI on AI Gateway" })
  // The next step skips a locked one the person cannot act on.
  const next = computeActivationState(facts({
    firstResponse: { done: true, durationMs: 900 }, invite: { canInvite: false, invitedByMe: 0, teammates: 1, joined: 2, pending: 0 },
    skillUsed: true, ownProvider: { reportedOnDevice: true, addedProviderName: null, orgProvided: false, canConfigure: true }, gateway: { canManage: false, hasProvider: false, providerName: null },
  }))
  assert.equal(nextActivationStep(next)?.id, "connector")
})

test("provider, skill and connection steps check off only from what actually happened", () => {
  const device = computeActivationState(facts({ ownProvider: { reportedOnDevice: true, addedProviderName: "Personal OpenAI", orgProvided: false, canConfigure: true } }))
  assert.deepEqual(device.steps[3], { id: "own_provider", done: true, detail: "Your key, on this device" })
  assert.deepEqual(computeActivationState(facts({ ownProvider: { reportedOnDevice: false, addedProviderName: "Personal OpenAI", orgProvided: false, canConfigure: true } })).steps[3]?.detail, "Personal OpenAI added")
  assert.equal(computeActivationState(facts({ skillUsed: true })).steps[2]?.done, true)
  assert.deepEqual(computeActivationState(facts({ readyConnectionName: "Google Workspace" })).steps[5], { id: "connector", done: true, detail: "Google Workspace connected" })
})

test("a member whose organization provides models centrally checks off the provider step without setting one up", () => {
  // The org has providers (Den/managed models an admin provisioned): the member has a model provider to use.
  const managed = computeActivationState(facts({ ownProvider: { reportedOnDevice: false, addedProviderName: null, orgProvided: true, canConfigure: true } }))
  assert.deepEqual(managed.steps[3], { id: "own_provider", done: true, detail: "Models from your organization" })
  // A member who also saved their own key keeps their own, more specific detail.
  const own = computeActivationState(facts({ ownProvider: { reportedOnDevice: true, addedProviderName: null, orgProvided: true, canConfigure: true } }))
  assert.equal(own.steps[3]?.detail, "Your key, on this device")
})

test("the provider step is never an un-completable blocker when the organization disables personal providers", () => {
  // No org providers yet, but the org allows only its own: the step checks off rather than blocking.
  const disabled = computeActivationState(facts({ ownProvider: { reportedOnDevice: false, addedProviderName: null, orgProvided: false, canConfigure: false } }))
  assert.deepEqual(disabled.steps[3], { id: "own_provider", done: true, detail: "Your team manages models" })
  // Org-provided models take precedence over the disabled notice.
  const both = computeActivationState(facts({ ownProvider: { reportedOnDevice: false, addedProviderName: null, orgProvided: true, canConfigure: false } }))
  assert.equal(both.steps[3]?.detail, "Models from your organization")
  // A member who may configure, with no org providers and no personal setup, still sees the step open.
  const open = computeActivationState(facts({ ownProvider: { reportedOnDevice: false, addedProviderName: null, orgProvided: false, canConfigure: true } }))
  assert.equal(open.steps[3]?.done, false)
})

test("hiding collapses to the next line, and the checklist disappears at six of six", () => {
  const all: ActivationFacts = {
    firstResponse: { done: true, durationMs: 1000 },
    invite: { canInvite: true, invitedByMe: 1, teammates: 1, joined: 2, pending: 0 },
    skillUsed: true,
    ownProvider: { reportedOnDevice: true, addedProviderName: null, orgProvided: false, canConfigure: true },
    gateway: { canManage: true, hasProvider: true, providerName: "Team OpenAI" },
    readyConnectionName: "Slack",
    ownerName: "Avery Owner",
    dismissed: false,
  }
  assert.equal(activationChecklistPresentation(computeActivationState(facts({ firstResponse: { done: true, durationMs: 1 }, dismissed: true }))), "next")
  const complete = computeActivationState(all)
  assert.deepEqual(activationProgress(complete), { done: 6, total: 6, complete: true })
  assert.equal(activationChecklistPresentation(complete), "hidden")
  assert.equal(nextActivationStep(complete), null)
  // A step an older Den does not send counts as not done, in recipe order.
  assert.deepEqual(orderedActivationSteps({ steps: [{ id: "connector", done: true }] }).map((step) => step.done), [false, false, false, false, false, true])
})
