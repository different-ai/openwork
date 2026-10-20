import { expect, test } from "bun:test"
import type { DynamicToolUIPart } from "ai"
import { isCredentialPromptPart } from "../src/components/chat/credential-prompt"

test("a recorded script with two trusted setup requests is recognized as requiring credential cards", () => {
  const calls = ["emc_first", "emc_second"].map((connectionId) => ({
    tool: "openwork-cloud.execute_capability", status: "completed", input: { name: "postMcpConnections", body: { name: connectionId } },
  }))
  const part: DynamicToolUIPart = { type: "dynamic-tool", toolName: "execute", toolCallId: "call_plural", state: "output-available", input: {}, output: "done",
    callProviderMetadata: { openwork: { codeMode: { calls, details: calls.map((call, ordinal) => ({
      tool: call.tool, input: call.input, ordinal, output: { credentialPrompt: { schemaVersion: "1", kind: "credential_prompt", name: `Project service ${ordinal + 1}`, destination: "https://fixture.example/mcp", target: { type: "mcp_connection_key", connectionId: ordinal === 0 ? "emc_first" : "emc_second" } } },
    })) } } },
  }
  expect(isCredentialPromptPart(part)).toBe(true)
})
