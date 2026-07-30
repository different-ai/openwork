import { describe, expect, test } from "bun:test"
import {
  calculateEffectiveDesktopPolicy,
  desktopPolicyDefaults,
  normalizeDesktopPolicyDocument,
  normalizeDesktopPolicyValue,
  resolveDesktopPolicyDocumentWrite,
} from "@openwork/types/den/desktop-policies"

describe("desktop policy JSON column strings", () => {
  test("normalizes policy value JSON strings", () => {
    expect(normalizeDesktopPolicyValue(JSON.stringify({ allowCustomProviders: false }))).toEqual({
      allowCustomProviders: false,
    })
  })

  test("normalizes full policy document JSON strings", () => {
    const document = {
      allowCustomProviders: false,
      allowZenModel: false,
      onboardingPrompts: ["Review workspace policy", "Connect approved tools"],
      onboardingPromptDescriptions: ["Policy review", "Tool connection"],
    }

    expect(normalizeDesktopPolicyDocument(JSON.stringify(document))).toEqual(document)
  })

  test("preserves onboarding prompts from string existing policies", () => {
    const existingPolicy = {
      allowCustomProviders: true,
      onboardingPrompts: ["Existing prompt one", "Existing prompt two"],
      onboardingPromptDescriptions: ["Existing card one", "Existing card two"],
    }

    expect(resolveDesktopPolicyDocumentWrite({
      value: { allowCustomProviders: false },
      existingPolicy: JSON.stringify(existingPolicy),
      isDefault: true,
      preserveExistingOnboardingPrompts: true,
    })).toEqual({
      ...desktopPolicyDefaults,
      allowCustomProviders: false,
      onboardingPrompts: existingPolicy.onboardingPrompts,
      onboardingPromptDescriptions: existingPolicy.onboardingPromptDescriptions,
    })
  })

  test("calculates effective policy the same for object and string policy documents", () => {
    const defaultPolicy = {
      allowCustomProviders: false,
      allowZenModel: false,
      onboardingPrompts: ["Default prompt one", "Default prompt two"],
    }
    const assignedPolicy = {
      allowCustomProviders: true,
      allowMultipleWorkspaces: true,
      onboardingPrompts: ["Assigned prompt one", "Assigned prompt two"],
    }
    const objectResult = calculateEffectiveDesktopPolicy({
      orgPolicyCount: 2,
      defaultPolicy,
      assignedPolicies: [assignedPolicy],
    })
    const stringResult = calculateEffectiveDesktopPolicy({
      orgPolicyCount: 2,
      defaultPolicy: JSON.stringify(defaultPolicy),
      assignedPolicies: [JSON.stringify(assignedPolicy)],
    })

    expect(stringResult).toEqual(objectResult)
    expect(stringResult.allowCustomProviders).toBe(true)
    expect(stringResult.allowZenModel).toBe(false)
  })

  test("normalizes non-JSON garbage strings to empty policy values", () => {
    expect(normalizeDesktopPolicyValue("not-json")).toEqual({})
  })
})
