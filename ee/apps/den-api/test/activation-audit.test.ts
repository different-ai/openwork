import assert from "node:assert/strict"
import { test } from "node:test"
import { auditRouteDeclarations, auditRouteEventTypes } from "../src/audit/routes/index.js"

test("each activation endpoint declares tenant evidence with its authenticated attribution", () => {
  const endpoints = [
    { method: "GET", path: "/v1/me/activation", auditClass: "tenant_read", attribution: "org_context", event: "activation.read.served" },
    { method: "POST", path: "/v1/me/activation/events", auditClass: "tenant_signal", attribution: "org_context", event: "activation.event.report.observed" },
    { method: "GET", path: "/v1/workbot/activation", auditClass: "tenant_read", attribution: "handler", event: "workbot.activation.read.served" },
    { method: "POST", path: "/v1/workbot/activation/events", auditClass: "tenant_signal", attribution: "handler", event: "workbot.activation.event.report.observed" },
  ]
  for (const endpoint of endpoints) {
    const matches = auditRouteDeclarations.filter((entry) => entry.method === endpoint.method && entry.path === endpoint.path)
    assert.equal(matches.length, 1, `${endpoint.method} ${endpoint.path}`)
    const declaration = matches[0]
    assert.ok(declaration)
    assert.equal(declaration.class, endpoint.auditClass)
    assert.equal(declaration.attribution, endpoint.attribution)
    assert.equal(declaration.resource.type, "activation_checklist")
    assert.ok(auditRouteEventTypes(declaration).includes(endpoint.event))
  }
})
