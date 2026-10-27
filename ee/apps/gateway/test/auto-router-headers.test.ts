import assert from "node:assert/strict"
import { test } from "node:test"
import {
  AUTO_ROUTER_RESPONSE_MODEL_HEADER,
  AUTO_ROUTER_RESPONSE_MODEL_NAME_HEADER,
  AUTO_ROUTER_RESPONSE_PROVIDER_HEADER,
  AUTO_ROUTER_RESPONSE_REASON_HEADER,
  AUTO_ROUTER_RESPONSE_THINKING_HEADER,
} from "@openwork/types/den/auto-router"
import { withRouteHeaders } from "../src/auto-router/handler.js"

test("an Auto response names the routed model in headers the desktop can read", async () => {
  const upstream = new Response("{}", { status: 200, headers: { "content-length": "2" } })
  const response = withRouteHeaders(upstream, { provider: "anthropic", model: "claude-haiku-5-5", thinking: "high", reason: "jev", name: "Claude Haiku 5.5 · Fast" }, "{}", "application/json")
  assert.equal(response.headers.get(AUTO_ROUTER_RESPONSE_PROVIDER_HEADER), "anthropic")
  assert.equal(response.headers.get(AUTO_ROUTER_RESPONSE_MODEL_HEADER), "claude-haiku-5-5")
  assert.equal(response.headers.get(AUTO_ROUTER_RESPONSE_THINKING_HEADER), "high")
  assert.equal(response.headers.get(AUTO_ROUTER_RESPONSE_REASON_HEADER), "jev")
  // Header values are bytes; a name with any character survives the round trip.
  assert.equal(decodeURIComponent(response.headers.get(AUTO_ROUTER_RESPONSE_MODEL_NAME_HEADER) ?? ""), "Claude Haiku 5.5 · Fast")
  assert.equal(response.headers.get("content-length"), null)
  assert.equal(await response.text(), "{}")
})

test("a route without a name sends no name header", () => {
  const response = withRouteHeaders(new Response(null), { provider: "anthropic", model: "claude-haiku-5-5", thinking: "default", reason: "fallback" }, null)
  assert.equal(response.headers.get(AUTO_ROUTER_RESPONSE_MODEL_NAME_HEADER), null)
})
