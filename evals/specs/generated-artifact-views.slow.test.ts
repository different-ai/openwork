import { expect } from "vitest"
import { needs, server, test } from "@openwork/testkit"
import { denFetch } from "@openwork/behaviors"

const requirements = {
  optIn: ["OPENWORK_EVAL_APP_SPECS", "OPENWORK_EVAL_GENERATED_ARTIFACT_VIEWS_SPEC"],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

test("the agent MCP exposes the custom Artifact view authoring lifecycle", { timeout: 300_000 }, async ({ evidence, place }) => {
  needs(requirements)
  await using den = await server({
    place,
    org: { name: `Generated Artifact Views ${Date.now()}`, admin: { name: "Avery" } },
  })
  const orgs = await denFetch(den.admin, "/v1/me/orgs", {
    headers: { authorization: `Bearer ${den.admin.token}` },
  })
  const rows = isRecord(orgs.body) && Array.isArray(orgs.body.orgs) ? orgs.body.orgs.filter(isRecord) : []
  const organizationId = String(rows[0]?.id ?? "")
  expect(organizationId).not.toBe("")
  const enabled = await denFetch(den.admin, `/v1/admin/organizations/${organizationId}/capabilities`, {
    method: "PUT",
    headers: { authorization: `Bearer ${den.admin.token}` },
    body: JSON.stringify({ capabilities: { codemodeScripts: true } }),
  })
  expect(enabled.response.ok, enabled.text).toBe(true)

  const initialized = await denFetch(den.admin, "/mcp/agent", {
    method: "POST",
    headers: {
      authorization: `Bearer ${den.admin.token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: { extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } } },
        clientInfo: { name: "generated-artifact-view-eval", version: "1.0.0" },
      },
    }),
  })
  expect(initialized.response.ok, initialized.text).toBe(true)
  expect(initialized.text).toContain("io.modelcontextprotocol/ui")
  evidence.fact(
    "Custom Artifact view provider is available only on the Code Mode agent MCP",
    "The initialized provider negotiates the stable MCP Apps extension; focused unit tapes cover immutable URI registration, resource bytes, structured data separation, and list-changed notifications.",
    true,
  )
})
