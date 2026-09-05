import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client"
import {
  EnterpriseMcpClientError,
  EnterpriseMcpLifecycleDeadlineError,
  isEnterpriseMcpLifecycleDeadline,
} from "../src/index.js"

describe("lifecycle deadline error", () => {
  it("aborts with an SdkError so the SDK rethrows it instead of stringifying the reason", () => {
    const error = new EnterpriseMcpLifecycleDeadlineError("tool-execution")

    // The SDK only passes an abort reason through untouched when it is already
    // an SdkError; anything else becomes String(reason) on a new RequestTimeout.
    assert.ok(error instanceof SdkError)
    assert.equal(error.code, SdkErrorCode.RequestTimeout)
    assert.equal(error.operationPhase, "tool-execution")
    assert.match(error.message, /exceeded its lifecycle deadline/)
  })

  it("carries a marker that survives an SDK round trip", () => {
    const reason = new EnterpriseMcpLifecycleDeadlineError("tool-execution")
    const rethrown = reason instanceof SdkError ? reason : new SdkError(SdkErrorCode.RequestTimeout, String(reason))

    assert.ok(isEnterpriseMcpLifecycleDeadline(rethrown))
  })

  it("detects the deadline through a wrapped cause chain", () => {
    const wrapped = new EnterpriseMcpClientError({
      operationPhase: "tool-execution",
      requestPhase: "mcp-tool-execution",
      cause: new EnterpriseMcpLifecycleDeadlineError("tool-execution"),
    })

    assert.ok(isEnterpriseMcpLifecycleDeadline(wrapped))
  })

  it("does not claim a provider's own RequestTimeout as ours", () => {
    const providerError = new SdkError(SdkErrorCode.RequestTimeout, "upstream is busy", { provider_detail: "busy" })

    assert.equal(isEnterpriseMcpLifecycleDeadline(providerError), false)
    assert.equal(isEnterpriseMcpLifecycleDeadline(new Error("unrelated")), false)
    assert.equal(isEnterpriseMcpLifecycleDeadline(undefined), false)
  })
})
