import assert from "node:assert/strict"
import { test } from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import {
  EXTERNAL_MCP_SLACK_MCP_ACCESS_DISABLED_CODE,
  ExternalMcpDiagnosticTracker,
  createExternalMcpDiagnosticFetch,
  externalMcpProviderSettingsLink,
  slackAppSettingsUrl,
} from "../src/capability-sources/external-mcp-diagnostics.ts"
import { connectCallbackPage } from "../src/capability-sources/oauth-callback-page.ts"

const slackEndpoint = "https://mcp.slack.com/mcp"
const otherEndpoint = "https://mcp.example.test/mcp"
// Synthetic app id; never a real Slack app.
const appId = "AFIXTURE123"
const slackRefusalText = `App is not enabled for Slack MCP server access. Please enable it here: https://api.slack.com/apps/${appId}/app-assistant`
const slackSettingsUrl = `https://api.slack.com/apps/${appId}/app-assistant`
const sentinel = "fixture-private-key-0123456789"

/** Runs a real MCP SDK initialize against a canned refusal and returns the diagnostic people see. */
async function sdkInitializeFailure(input: { endpoint: string; status: number; body: string }) {
  const tracker = new ExternalMcpDiagnosticTracker("ref-refusal", { authType: "oauth", credentialMode: "per_member" })
  const transport = new StreamableHTTPClientTransport(new URL(input.endpoint), {
    fetch: createExternalMcpDiagnosticFetch({
      endpoint: input.endpoint,
      tracker,
      fetch: async () => new Response(input.body, { status: input.status, headers: { "content-type": "application/json" } }),
    }),
  })
  const client = new Client({ name: "den-api-test", version: "1" })
  tracker.begin("MCP_INITIALIZE")
  try {
    await client.connect(transport)
  } catch (error) {
    return tracker.error(error, "MCP_INITIALIZE").diagnostic
  } finally {
    await client.close().catch(() => undefined)
  }
  throw new Error("initialize unexpectedly succeeded")
}

test("Slack's refusal for an app without MCP access names the setting to turn on and links to it", async () => {
  // Slack has answered both as a JSON-RPC error object and with top-level fields.
  const bodies = [
    JSON.stringify({ error_code: -32600, error_message: slackRefusalText }),
    JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: slackRefusalText } }),
  ]
  for (const body of bodies) {
    const diagnostic = await sdkInitializeFailure({ endpoint: slackEndpoint, status: 400, body })
    assert.equal(diagnostic.code, EXTERNAL_MCP_SLACK_MCP_ACCESS_DISABLED_CODE)
    assert.equal(diagnostic.phase, "MCP_INITIALIZE")
    assert.equal(diagnostic.actionOwner, "organization_admin")
    assert.equal(diagnostic.retryable, false)
    assert.equal(diagnostic.httpStatus, 400)
    assert.equal(diagnostic.jsonRpcCode, -32600)
    assert.equal(
      diagnostic.message,
      "The Slack app for this connection doesn't have MCP access turned on. In the Slack app's settings, open Agents and turn on MCP, then connect again.",
    )
    // The person-facing sentence carries no raw provider text (T2); agents and logs keep it.
    assert.ok(!diagnostic.message.includes("api.slack.com"))
    assert.equal(diagnostic.providerErrorMessage, slackRefusalText)
    assert.equal(diagnostic.providerSettingsUrl, slackSettingsUrl)
    assert.deepEqual(externalMcpProviderSettingsLink(diagnostic), { label: "Open Slack app settings", href: slackSettingsUrl })
  }
})

test("the same words from a server that is not Slack's are not trusted as Slack guidance", async () => {
  const diagnostic = await sdkInitializeFailure({
    endpoint: otherEndpoint,
    status: 400,
    body: JSON.stringify({ error_code: -32600, error_message: slackRefusalText }),
  })
  assert.equal(diagnostic.code, "MCP_HTTP_400")
  assert.equal(diagnostic.providerSettingsUrl, undefined)
  assert.equal(externalMcpProviderSettingsLink(diagnostic), undefined)
})

test("any server's stated refusal reason is shown with the refusal instead of a bare status", async () => {
  const diagnostic = await sdkInitializeFailure({
    endpoint: otherEndpoint,
    status: 400,
    body: JSON.stringify({ error_code: -32000, error_message: "Workspace has not enabled this integration." }),
  })
  assert.equal(diagnostic.code, "MCP_HTTP_400")
  assert.equal(diagnostic.category, "http_failure")
  assert.equal(diagnostic.jsonRpcCode, -32000)
  assert.equal(diagnostic.providerErrorMessage, "Workspace has not enabled this integration.")
  assert.equal(
    diagnostic.message,
    "The MCP server refused to start a session (HTTP 400). Provider-declared message (untrusted): \"Workspace has not enabled this integration.\".",
  )
  assert.equal(diagnostic.providerResponseExcerpt, JSON.stringify({ error_code: -32000, error_message: "Workspace has not enabled this integration." }))
})

test("stated refusal text is untrusted: control characters stripped, credentials redacted, length capped", async () => {
  const long = `Denied\u0000\u001b[31m <b>bold</b> Bearer ${sentinel} ${"x ".repeat(240)}`
  const body = JSON.stringify({ error_code: -32000, error_message: long })
  // The whole body fits the bounded read, so only the message cap applies.
  assert.ok(long.length > 512 && body.length < 600)
  const diagnostic = await sdkInitializeFailure({ endpoint: otherEndpoint, status: 400, body })
  const message = diagnostic.providerErrorMessage ?? ""
  assert.ok(message.startsWith("Denied"))
  assert.equal(message.length, 512)
  assert.doesNotMatch(message, /[\u0000-\u001F\u007F-\u009F]/)
  assert.ok(!JSON.stringify(diagnostic).includes(sentinel))
  // HTML stays inert text; the completion page escapes it.
  const page = connectCallbackPage({ ok: false, name: "Fixture", message: diagnostic.message })
  assert.ok(page.includes("&lt;b&gt;bold&lt;/b&gt;"))
  assert.ok(!page.includes("<b>bold</b>"))
})

test("a refused credential's stated reason is never kept, because it can repeat the key", async () => {
  for (const status of [401, 403]) {
    const diagnostic = await sdkInitializeFailure({
      endpoint: otherEndpoint,
      status,
      body: JSON.stringify({ error_code: -32001, error_message: `invalid key ${sentinel}` }),
    })
    assert.equal(diagnostic.providerErrorMessage, undefined)
    assert.equal(diagnostic.jsonRpcCode, undefined)
    assert.ok(!diagnostic.message.includes(sentinel))
  }
})

test("only an https api.slack.com app page becomes the settings link", () => {
  assert.equal(slackAppSettingsUrl(slackRefusalText), slackSettingsUrl)
  assert.equal(slackAppSettingsUrl(`enable it here: https://api.slack.com/apps/${appId}.`), `https://api.slack.com/apps/${appId}`)
  assert.equal(slackAppSettingsUrl(`https://api.slack.com/apps/${appId}/app-assistant?next=https://evil.example#x`), slackSettingsUrl)
  for (const text of [
    `http://api.slack.com/apps/${appId}/app-assistant`,
    `https://api.slack.com.evil.example/apps/${appId}`,
    `https://user:pass@api.slack.com/apps/${appId}`,
    `https://api.slack.com:8443/apps/${appId}`,
    `https://api.slack.com/apps/${appId}/../../logout`,
    "https://api.slack.com/apps/",
    "https://api.slack.com/apps/<script>",
    "no link here",
  ]) {
    assert.equal(slackAppSettingsUrl(text), undefined, text)
  }
})

test("the completion page offers the settings link only when it is https, and escapes it", () => {
  const page = connectCallbackPage({
    ok: false,
    name: "Slack",
    message: "The Slack app for this connection doesn't have MCP access turned on.",
    referenceId: "ref-fixture",
    fixLink: { label: "Open Slack app settings", href: `${slackSettingsUrl}?a="b"` },
  })
  assert.ok(page.includes(`<a class="fix-link" href="${slackSettingsUrl}?a=&quot;b&quot;" target="_blank" rel="noopener noreferrer">Open Slack app settings</a>`))
  assert.ok(page.includes("Diagnostic reference: <code>ref-fixture</code>"))

  const unsafe = connectCallbackPage({
    ok: false,
    name: "Slack",
    message: "Failed.",
    fixLink: { label: "Open Slack app settings", href: "javascript:alert(1)" },
  })
  assert.ok(!unsafe.includes("fix-link\" href"))
  assert.ok(!unsafe.includes("javascript:"))
})
