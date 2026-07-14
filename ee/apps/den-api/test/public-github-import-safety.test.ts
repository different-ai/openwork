import { describe, expect, test } from "bun:test"
import { Buffer } from "node:buffer"
import {
  assertPublicGithubTreeWithinLimits,
  createPublicGithubRequestBudget,
  decodePublicGithubBase64File,
  PUBLIC_GITHUB_IMPORT_LIMITS,
  PublicGithubRequestError,
  readBoundedGithubResponseText,
  requestPublicGithubJson,
  resolvePublicGithubRefAndPath,
} from "../src/routes/org/plugin-system/public-github.js"

function expectGithubError(error: unknown, code: string) {
  expect(error).toBeInstanceOf(PublicGithubRequestError)
  expect((error as PublicGithubRequestError).code).toBe(code)
}

describe("public GitHub import safety", () => {
  test("keeps anonymous GitHub inspection ceilings intentionally small", () => {
    expect(PUBLIC_GITHUB_IMPORT_LIMITS.apiCalls).toBe(24)
    expect(PUBLIC_GITHUB_IMPORT_LIMITS.refCandidates).toBe(12)
    expect(PUBLIC_GITHUB_IMPORT_LIMITS.files).toBe(20)
  })

  test("rejects recursive tree truncation and excessive entry counts", () => {
    expect(() => assertPublicGithubTreeWithinLimits({ entryCount: 1, truncated: true }))
      .toThrow("GitHub truncated")
    try {
      assertPublicGithubTreeWithinLimits({
        entryCount: PUBLIC_GITHUB_IMPORT_LIMITS.treeEntries + 1,
        truncated: false,
      })
      throw new Error("expected tree limit failure")
    } catch (error) {
      expectGithubError(error, "github_import_limit_exceeded")
    }
  })

  test("resolves slash-containing refs by the longest valid GitHub prefix", async () => {
    const attempted: string[] = []
    const resolved = await resolvePublicGithubRefAndPath({
      defaultRef: "main",
      refAndPathSegments: ["feature", "oauth", "plugins", "atlassian"],
      resolveRef: async (ref) => {
        attempted.push(ref)
        return ref === "feature/oauth" ? { sha: "immutable-sha" } : null
      },
    })

    expect(attempted).toEqual([
      "feature/oauth/plugins/atlassian",
      "feature/oauth/plugins",
      "feature/oauth",
    ])
    expect(resolved).toEqual({
      ref: "feature/oauth",
      resolved: { sha: "immutable-sha" },
      rootPath: "plugins/atlassian",
    })
  })

  test("rejects tree URLs too ambiguous to resolve within the request budget", async () => {
    try {
      await resolvePublicGithubRefAndPath({
        defaultRef: "main",
        refAndPathSegments: Array.from({ length: PUBLIC_GITHUB_IMPORT_LIMITS.refCandidates + 1 }, (_, index) => `segment-${index}`),
        resolveRef: async () => null,
      })
      throw new Error("expected ambiguous ref failure")
    } catch (error) {
      expectGithubError(error, "ambiguous_github_tree_ref")
    }
  })

  test("aborts GitHub requests that exceed the bounded timeout", async () => {
    const fetchImpl = ((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
    })) as typeof fetch

    try {
      await requestPublicGithubJson({
        budget: createPublicGithubRequestBudget(),
        fetchImpl,
        path: "/repos/example/plugin",
        timeoutMs: 5,
      })
      throw new Error("expected request timeout")
    } catch (error) {
      expectGithubError(error, "github_request_timeout")
    }
  })

  test("caps every request by the remaining aggregate inspection deadline", async () => {
    const fetchImpl = ((_url: URL | RequestInfo, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true })
    })) as typeof fetch

    try {
      await requestPublicGithubJson({
        budget: createPublicGithubRequestBudget({ operationTimeoutMs: 5 }),
        fetchImpl,
        path: "/repos/example/plugin",
        timeoutMs: 1_000,
      })
      throw new Error("expected aggregate request timeout")
    } catch (error) {
      expectGithubError(error, "github_request_timeout")
    }
  })

  test("does not issue another request after the aggregate deadline expires", async () => {
    const budget = createPublicGithubRequestBudget()
    budget.deadlineAt = Date.now() - 1
    let called = false
    const fetchImpl = (async () => {
      called = true
      return Response.json({ ok: true })
    }) as typeof fetch

    try {
      await requestPublicGithubJson({ budget, fetchImpl, path: "/repos/example/plugin" })
      throw new Error("expected aggregate request timeout")
    } catch (error) {
      expectGithubError(error, "github_request_timeout")
    }
    expect(called).toBe(false)
  })

  test("stops reading a response after its byte ceiling", async () => {
    const response = new Response("x".repeat(33))
    try {
      await readBoundedGithubResponseText(response, 32)
      throw new Error("expected response size failure")
    } catch (error) {
      expectGithubError(error, "github_response_too_large")
    }
  })

  test("caps API calls before issuing another request", async () => {
    const budget = createPublicGithubRequestBudget()
    budget.apiCalls = PUBLIC_GITHUB_IMPORT_LIMITS.apiCalls
    let called = false
    const fetchImpl = (async () => {
      called = true
      return Response.json({ ok: true })
    }) as typeof fetch

    try {
      await requestPublicGithubJson({ budget, fetchImpl, path: "/rate-limited" })
      throw new Error("expected API call limit failure")
    } catch (error) {
      expectGithubError(error, "github_import_limit_exceeded")
    }
    expect(called).toBe(false)
  })

  test("caps unique files and cumulative decoded bytes", () => {
    const fileBudget = createPublicGithubRequestBudget()
    for (let index = 0; index < PUBLIC_GITHUB_IMPORT_LIMITS.files; index += 1) {
      fileBudget.files.add(`existing-${index}`)
    }
    expect(() => decodePublicGithubBase64File({
      base64: Buffer.from("ok").toString("base64"),
      budget: fileBudget,
      path: "one-too-many.md",
    })).toThrow(`more than ${PUBLIC_GITHUB_IMPORT_LIMITS.files} files`)

    const byteBudget = createPublicGithubRequestBudget()
    byteBudget.decodedBytes = PUBLIC_GITHUB_IMPORT_LIMITS.decodedBytes
    expect(() => decodePublicGithubBase64File({
      base64: Buffer.from("x").toString("base64"),
      budget: byteBudget,
      path: "overflow.md",
    })).toThrow(`more than ${PUBLIC_GITHUB_IMPORT_LIMITS.decodedBytes} decoded bytes`)
  })
})
