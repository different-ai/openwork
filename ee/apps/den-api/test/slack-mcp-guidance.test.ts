import assert from "node:assert/strict"
import { test } from "node:test"
import { slackMcpAccessGuidance, safeSlackMcpSettingsUrl } from "../src/capability-sources/slack-mcp-guidance.ts"
import { connectCallbackPage } from "../src/capability-sources/oauth-callback-page.ts"

const disabled = "App is not enabled for Slack MCP server access."

function guidance(message: string) {
  return slackMcpAccessGuidance({
    phase: "MCP_INITIALIZE",
    httpStatus: 400,
    outbound: { origin: "https://mcp.slack.com" },
    providerResponseExcerpt: JSON.stringify({ error_code: -32600, error_message: message }),
  })
}

test("Slack recovery never trusts provider prose or arbitrary URLs", () => {
  const unsafeUrls = [
    "javascript:alert(1)",
    "https://api.slack.com.evil.example/apps/A0123456789/app-assistant",
    "https://api.slack.com@evil.example/apps/A0123456789/app-assistant",
    "https://api.slack.com/apps/A0123456789/app-assistant?token=private-sentinel",
    "https://api.slack.com/apps/A0123456789/app-assistant#private-sentinel",
    'https://api.slack.com/apps/A0123456789/app-assistant\" onclick=\"alert(1)',
    "http://api.slack.com/apps/A0123456789/app-assistant",
  ]
  for (const url of unsafeUrls) {
    const recovery = guidance(`${disabled} Please enable it here: ${url}`)
    assert.equal(recovery?.settingsUrl, "https://api.slack.com/apps")
    assert.ok(!recovery?.message.includes(url))
    assert.equal(safeSlackMcpSettingsUrl(url), undefined)
    const page = connectCallbackPage({ ok: false, name: "Slack", message: "Safe message", providerSetupUrl: url })
    assert.doesNotMatch(page, /Open Slack app settings|onclick|private-sentinel|evil\.example|javascript:/)
  }
  assert.equal(guidance(disabled)?.settingsUrl, "https://api.slack.com/apps")
  assert.equal(safeSlackMcpSettingsUrl("https://api.slack.com/apps/A0123456789/app-assistant"), "https://api.slack.com/apps/A0123456789/app-assistant")
  assert.equal(safeSlackMcpSettingsUrl("https://api.slack.com/apps/A0123456789/app-assistant\n"), undefined)
})

test("signed Workbot returns still hide provider setup details", () => {
  const page = connectCallbackPage({
    ok: false,
    name: "Slack",
    message: "Provider-specific guidance",
    providerSetupUrl: "https://api.slack.com/apps/A0123456789/app-assistant",
  }, {
    origin: "https://workbot.example.test",
    returnPath: "/documents",
    requestId: "00000000-0000-4000-8000-000000000001",
    connectionId: "fixture-connection",
  })
  assert.doesNotMatch(page, /Provider-specific guidance|api\.slack\.com|Open Slack app settings/)
  assert.match(page, /Return to Workbot/)
})

test("invalid, unrelated or wrong-phase evidence keeps the generic fallback", () => {
  for (const providerResponseExcerpt of ["bad JSON", "null", "[]", JSON.stringify({ message: disabled }), JSON.stringify({ error_code: -1, error_message: disabled })]) {
    assert.equal(slackMcpAccessGuidance({ phase: "MCP_INITIALIZE", httpStatus: 400, outbound: { origin: "https://mcp.slack.com" }, providerResponseExcerpt }), undefined)
  }
  assert.equal(slackMcpAccessGuidance({ phase: "AUTH_TOKEN_ACQUISITION", httpStatus: 400, outbound: { origin: "https://mcp.slack.com" }, providerResponseExcerpt: JSON.stringify({ error_code: -32600, error_message: disabled }) }), undefined)
})
