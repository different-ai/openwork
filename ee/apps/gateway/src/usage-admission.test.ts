import assert from "node:assert/strict"
import { test } from "node:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  admitGatewayUsage,
  enforceUsageAdmissionForAll,
  type CheckGatewayUsage,
  type UsageAdmissionDecision,
  type UsageAdmissionPolicy,
} from "./usage-admission.js"

const organizationId = createDenTypeId("organization")
const organization = { id: organizationId, metadata: null }

const input: Parameters<CheckGatewayUsage>[0] = {
  organizationId,
  memberId: createDenTypeId("member"),
  requestId: "request_test",
  protocol: "openai_chat",
  providerId: "openai",
  modelId: "gpt-4o-mini",
  upstreamOrigin: "https://api.openai.com",
  upstreamPath: "/v1/chat/completions",
  deferred: false,
}

const skipUsageAdmission: UsageAdmissionPolicy = async (): Promise<UsageAdmissionDecision> => "skip"

function recordingCheck(response: Response | null) {
  const calls: Parameters<CheckGatewayUsage>[0][] = []
  const checkUsage: CheckGatewayUsage = async (call) => {
    calls.push(call)
    return response
  }
  return { calls, checkUsage }
}

test("the default policy enforces admission for every organization", async () => {
  assert.equal(await enforceUsageAdmissionForAll({ organizationId: "organization_a", organization: null }), "enforce")
  assert.equal(await enforceUsageAdmissionForAll({ organizationId: "organization_b", organization }), "enforce")
})

test("enforce calls checkUsage once with the request and returns its rejection", async () => {
  const blocked = new Response(null, { status: 429 })
  const { calls, checkUsage } = recordingCheck(blocked)
  const policyInputs: Parameters<UsageAdmissionPolicy>[0][] = []
  const usageAdmission: UsageAdmissionPolicy = (policyInput) => {
    policyInputs.push(policyInput)
    return "enforce"
  }

  const result = await admitGatewayUsage({ usageAdmission, checkUsage }, organization, input)

  assert.equal(result, blocked)
  assert.deepEqual(calls, [input])
  assert.deepEqual(policyInputs, [{ organizationId, organization }])
})

test("enforce passes an admitted request through as null", async () => {
  const { calls, checkUsage } = recordingCheck(null)
  const result = await admitGatewayUsage({ usageAdmission: enforceUsageAdmissionForAll, checkUsage }, organization, input)
  assert.equal(result, null)
  assert.equal(calls.length, 1)
})

test("skip never calls checkUsage, so a blocking check cannot reject and no snapshot is captured", async () => {
  const { calls, checkUsage } = recordingCheck(new Response(null, { status: 429 }))
  let snapshotCaptured = false
  const result = await admitGatewayUsage(
    { usageAdmission: skipUsageAdmission, checkUsage },
    null,
    { ...input, onAdmission: () => { snapshotCaptured = true } },
  )
  assert.equal(result, null)
  assert.equal(calls.length, 0)
  assert.equal(snapshotCaptured, false)
})
