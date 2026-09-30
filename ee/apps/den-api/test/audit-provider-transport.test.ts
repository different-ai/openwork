import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { AUDIT_CORRELATION_HEADER, createAuditOperationContext } from "@openwork/types/den/audit"
import { createDenClient } from "../../../../packages/sdk/src/client.js"
import { deleteGatewayResource, deleteInferenceProvider, saveGatewayResource, saveInferenceProvider } from "../../den-web/app/(den)/dashboard/_components/inference-provider-data.js"
import { ReauthRequiredError } from "../../den-web/app/(den)/_lib/den-flow.js"

const provider = { id: "ipr_synthetic", providerId: "synthetic", name: "Synthetic", credentialMode: "org", status: "active" }
async function withTransport(run: (calls: Request[]) => Promise<void>, rejectFirst = false) {
  const calls: Request[] = []
  const original = globalThis.fetch
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(new URL(String(input), "https://synthetic.example.test"), init)
    calls.push(request)
    if (rejectFirst && calls.length === 1) return Response.json({ error: "reauth", reason: "fresh_auth_required", message: "Confirm identity" }, { status: 403 })
    if (request.method === "DELETE") return new Response(null, { status: 204 })
    return Response.json({ inferenceProvider: provider })
  }
  try { await run(calls) } finally { globalThis.fetch = original }
}

test("one Save passes one explicit context through provider/group/set/grant calls and reauthentication", async () => {
  await withTransport(async (calls) => {
    const auditContext = createAuditOperationContext()
    const save = async () => {
      await saveInferenceProvider({ inferenceProviderId: provider.id, body: { name: "Updated" }, auditContext })
      await saveGatewayResource(provider.id, "group-synthetic", { resource: "model-groups", body: { name: "Models", modelIds: ["model-a"] } }, auditContext)
      await saveGatewayResource(provider.id, "set-synthetic", { resource: "credential-sets", body: { name: "Credentials", credentialMode: "org", credential: { kind: "api_key", secret: "synthetic-secret" } } }, auditContext)
      await deleteGatewayResource(provider.id, "access-grants", "old-grant", auditContext)
      await saveGatewayResource(provider.id, null, { resource: "access-grants", body: { modelGroupId: "group-synthetic", credentialSetId: "set-synthetic", audience: { type: "organization" } } }, auditContext)
    }
    await assert.rejects(save(), ReauthRequiredError)
    await save()
    assert.equal(calls.length, 6)
    assert.deepEqual(calls.map((request) => request.method), ["PATCH", "PATCH", "PATCH", "PATCH", "DELETE", "POST"])
    for (const request of calls) {
      assert.equal(request.headers.get(AUDIT_CORRELATION_HEADER), auditContext.correlationId)
      assert.equal(request.headers.has("x-openwork-origin"), false)
    }
    assert.equal(Object.isFrozen(auditContext), true)
    const nextInteraction = createAuditOperationContext()
    await deleteInferenceProvider(provider.id, nextInteraction)
    assert.equal(calls.at(-1)?.headers.get(AUDIT_CORRELATION_HEADER), nextInteraction.correlationId)
    assert.notEqual(nextInteraction.correlationId, auditContext.correlationId)
  }, true)
})

test("create/delete helpers are opt-in and independent concurrent interactions never share mutable IDs", async () => {
  await withTransport(async (calls) => {
    await saveInferenceProvider({ inferenceProviderId: null, body: { name: "Synthetic", providerId: "synthetic" } })
    assert.equal(calls[0].headers.has(AUDIT_CORRELATION_HEADER), false)
    const first = createAuditOperationContext()
    const second = createAuditOperationContext()
    await Promise.all([
      saveInferenceProvider({ inferenceProviderId: null, body: { name: "Synthetic", providerId: "synthetic" }, auditContext: first }),
      deleteInferenceProvider(provider.id, second),
    ])
    assert.equal(calls[1].headers.get(AUDIT_CORRELATION_HEADER), first.correlationId)
    assert.equal(calls[2].headers.get(AUDIT_CORRELATION_HEADER), second.correlationId)
  })
})

test("editor creates context outside both reauth callbacks and passes it into every Save branch", () => {
  const editor = readFileSync(new URL("../../den-web/app/(den)/dashboard/_components/inference-provider-editor-screen.tsx", import.meta.url), "utf8")
  assert.match(editor, /const auditContext = createAuditOperationContext\(\);\s*try \{\s*await runReauthableAction\("save-inference-provider"/)
  assert.match(editor, /const auditContext = createAuditOperationContext\(\);\s*try \{\s*await runReauthableAction\("delete-inference-provider"/)
  assert.match(editor, /await syncAccessAndCredential\(auditContext\)/)
  assert.match(editor, /deleteInferenceProvider\(provider.id, auditContext\)/)
  assert.equal(editor.match(/createAuditOperationContext\(\)/g)?.length, 2)
})

test("SDK context sets only the correlation header and preserves per-call overrides and auth header forms", async () => {
  await withTransport(async (calls) => {
    const context = createAuditOperationContext()
    const override = createAuditOperationContext()
    const client = createDenClient({ baseUrl: "https://synthetic.example.test", auditContext: context, token: "synthetic-session", apiKey: "synthetic-api-key", orgId: "org_synthetic", headers: new Headers({ "x-client-header": "preserved" }) })
    await client.patchV1InferenceProvidersByInferenceProviderId({ inferenceProviderId: provider.id, name: "Updated" })
    await client.deleteV1InferenceProvidersByInferenceProviderId({ inferenceProviderId: provider.id }, { headers: new Headers([[AUDIT_CORRELATION_HEADER.toLowerCase(), override.correlationId], ["authorization", "Bearer per-call"]]) })
    const ungrouped = createDenClient({ baseUrl: "https://synthetic.example.test" })
    await ungrouped.deleteV1InferenceProvidersByInferenceProviderId({ inferenceProviderId: provider.id })
    assert.equal(calls[0].headers.get(AUDIT_CORRELATION_HEADER), context.correlationId)
    assert.equal(calls[0].headers.get("authorization"), "Bearer synthetic-session")
    assert.equal(calls[0].headers.get("x-api-key"), "synthetic-api-key")
    assert.equal(calls[0].headers.get("x-openwork-org-id"), "org_synthetic")
    assert.equal(calls[0].headers.get("x-client-header"), "preserved")
    assert.equal(calls[1].headers.get(AUDIT_CORRELATION_HEADER), override.correlationId)
    assert.equal(calls[1].headers.get("authorization"), "Bearer per-call")
    assert.equal(calls[2].headers.has(AUDIT_CORRELATION_HEADER), false)
  })
})
