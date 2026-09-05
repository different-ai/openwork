import { describe, expect, test } from "bun:test"
import { createDenTypeId, isDenTypeId, normalizeDenTypeId, typeId } from "./typeid"

describe("workflow run TypeIDs", () => {
  test("creates canonical wfr IDs and parses legacy cmr IDs through workflowRun", () => {
    const workflowRunId = createDenTypeId("workflowRun")
    const legacyRunId = createDenTypeId("codemodeRun")

    expect(workflowRunId).toStartWith("wfr_")
    expect(legacyRunId).toStartWith("cmr_")
    expect(normalizeDenTypeId("workflowRun", workflowRunId)).toBe(workflowRunId)
    expect(normalizeDenTypeId("workflowRun", legacyRunId)).toBe(legacyRunId)
    expect(typeId.schema("workflowRun").parse(workflowRunId)).toBe(workflowRunId)
    expect(typeId.schema("workflowRun").parse(legacyRunId)).toBe(legacyRunId)
    expect(isDenTypeId("workflowRun", workflowRunId)).toBe(true)
    expect(isDenTypeId("workflowRun", legacyRunId)).toBe(true)
    expect(typeId.infer(workflowRunId)).toBe("workflowRun")
    expect(typeId.infer(legacyRunId)).toBe("codemodeRun")
  })
})
