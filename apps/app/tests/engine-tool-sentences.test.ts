import { expect, test } from "bun:test"
import type { DynamicToolUIPart } from "ai"
import { skillDisplayName } from "../src/lib/build-in-tools"
import { getCapabilityCallSentence } from "../src/lib/capability-call"

function call(toolName: string, input: unknown): DynamicToolUIPart {
  return { type: "dynamic-tool", toolCallId: "c1", toolName, input, state: "output-available", output: "{}" }
}

test("Code Mode engine tools never name the engine or its plumbing", () => {
  const index = getCapabilityCallSentence(call("opencode_read_mcp_resource", { server: "openwork-cloud", uri: "skill://index.json" }))
  expect(index).toMatchObject({ service: null, past: "Looked through your skills" })

  const skill = getCapabilityCallSentence(call("opencode_read_mcp_resource", { server: "openwork-cloud", uri: "skill://debug-openwork-logs-ex2w5r7s/SKILL.md" }))
  expect(skill).toMatchObject({ service: null, past: "Used your debug-openwork-logs skill" })

  const document = getCapabilityCallSentence(call("opencode_read_mcp_resource", { server: "openwork-cloud", uri: "openwork://agent/guidance.md" }))
  expect(document).toMatchObject({ service: "OpenWork Cloud", past: "Read a document from OpenWork Cloud" })

  expect(getCapabilityCallSentence(call("opencode_session_move", { directory: "/Users/me/work/repo-fix/" })).past).toBe("Moved this chat to repo-fix")
  expect(getCapabilityCallSentence(call("opencode_models", { query: "opus" })).past).toBe("Looked up models")

  for (const name of ["opencode_read_mcp_resource", "opencode_list_mcp_resources", "opencode_session_rename", "opencode_something_new"]) {
    const sentence = getCapabilityCallSentence(call(name, {}))
    expect(`${sentence.past} ${sentence.service ?? ""}`).not.toMatch(/opencode|mcp/i)
  }
})

test("the native skill tool names the skill a person would recognize", () => {
  expect(skillDisplayName({ id: "openwork-cloud-debug-openwork-logs-ex2w5r7s" })).toBe("debug-openwork-logs")
  expect(skillDisplayName({ id: "openwork-cloud-create-skill" })).toBe("create-skill")
  expect(skillDisplayName({ id: "release" })).toBe("release")
  expect(skillDisplayName({ name: "release" })).toBe("release")
  expect(skillDisplayName(undefined)).toBe("")
})
