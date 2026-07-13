import { describe, expect, test } from "bun:test"
import {
  BUNDLED_DEN_CAPABILITY_SOURCE_DESCRIPTORS,
  DEN_CAPABILITY_SOURCE_CONTRACT_VERSION,
  composeDenCapabilitySources,
  type DenCapabilitySearchType,
  type DenCapabilitySourceContribution,
  type DenCapabilitySourceDescriptor,
  type DenCapabilitySourceRuntime,
} from "../src/mcp/capability-source-composition.js"
import type { CapabilityMatch } from "../src/mcp/search.js"

type TestExecutionResult = string

function match(name: string, score: number): CapabilityMatch {
  return {
    name,
    method: "TEST",
    path: `test://${name}`,
    score,
    summary: `Test ${name}`,
    pathParams: [],
    queryParams: [],
    hasBody: false,
  }
}

function descriptor(input: {
  id: string
  order: number
  executionOrder?: number
  searchTypes?: readonly DenCapabilitySearchType[]
  contractVersion?: number
  requires?: readonly string[]
}): DenCapabilitySourceDescriptor {
  return {
    id: input.id,
    kind: "den-capability-source",
    contractVersion: input.contractVersion ?? DEN_CAPABILITY_SOURCE_CONTRACT_VERSION,
    provenance: { packageName: `test-${input.id}` },
    order: input.order,
    executionOrder: input.executionOrder ?? input.order,
    searchTypes: input.searchTypes ?? ["api"],
    purpose: `Test source ${input.id}`,
    ...(input.requires === undefined ? {} : { requires: input.requires }),
  }
}

function contribution(
  sourceDescriptor: DenCapabilitySourceDescriptor,
  runtime: DenCapabilitySourceRuntime<TestExecutionResult>,
  onConstruct?: () => void,
): DenCapabilitySourceContribution<TestExecutionResult> {
  return {
    descriptor: sourceDescriptor,
    binding: {
      status: "ready",
      create: () => {
        onConstruct?.()
        return runtime
      },
    },
  }
}

function inertRuntime(
  label: string,
  calls?: string[],
): DenCapabilitySourceRuntime<TestExecutionResult> {
  return {
    search: async () => {
      calls?.push(`search:${label}`)
      return { matches: [] }
    },
    execute: async () => {
      calls?.push(`execute:${label}`)
      return { status: "unhandled" }
    },
  }
}

function bundledContributions(
  runtimeFor: (
    sourceDescriptor: DenCapabilitySourceDescriptor,
  ) => DenCapabilitySourceRuntime<TestExecutionResult> = (sourceDescriptor) =>
    inertRuntime(sourceDescriptor.id),
): DenCapabilitySourceContribution<TestExecutionResult>[] {
  return Object.values(BUNDLED_DEN_CAPABILITY_SOURCE_DESCRIPTORS)
    .map((sourceDescriptor) => contribution(
      sourceDescriptor,
      runtimeFor(sourceDescriptor),
    ))
}

function ready(
  contributions: readonly DenCapabilitySourceContribution<TestExecutionResult>[],
) {
  const result = composeDenCapabilitySources(contributions)
  expect(result.status).toBe("ready")
  if (result.status !== "ready") throw new Error("Expected ready composition")
  return result
}

describe("Den MCP capability-source composition", () => {
  test("pins five serializable descriptors in the legacy search and execution orders", () => {
    const descriptors = Object.values(BUNDLED_DEN_CAPABILITY_SOURCE_DESCRIPTORS)

    expect(descriptors.map((item) => item.id)).toEqual([
      "den/capabilities/api-catalog",
      "den/capabilities/platform-admin",
      "den/capabilities/external-mcp",
      "den/capabilities/marketplace",
      "den/capabilities/skills",
    ])
    expect(descriptors.map((item) => item.order)).toEqual([100, 200, 300, 400, 500])
    expect(descriptors.map((item) => item.executionOrder)).toEqual([500, 100, 200, 300, 400])
    expect(descriptors.map((item) => item.searchTypes)).toEqual([
      ["api"],
      ["admin"],
      ["mcp"],
      ["marketplace", "skills"],
      ["skills"],
    ])
    expect(JSON.parse(JSON.stringify(descriptors))).toEqual(descriptors)
    expect(descriptors.every((item) =>
      !("binding" in item)
      && !("search" in item)
      && !("execute" in item)
    )).toBe(true)
  })

  test("preserves source filters, including marketplace skill objects", async () => {
    const calls: string[] = []
    const host = ready(bundledContributions((sourceDescriptor) =>
      inertRuntime(sourceDescriptor.id, calls)))

    await host.search({ query: "skill", limit: 5, type: "skills" })
    expect(calls).toEqual([
      "search:den/capabilities/marketplace",
      "search:den/capabilities/skills",
    ])

    calls.length = 0
    await host.search({ query: "admin", limit: 5, type: "admin" })
    expect(calls).toEqual(["search:den/capabilities/platform-admin"])

    calls.length = 0
    await host.search({ query: "everything", limit: 5 })
    expect(calls).toEqual([
      "search:den/capabilities/api-catalog",
      "search:den/capabilities/platform-admin",
      "search:den/capabilities/external-mcp",
      "search:den/capabilities/marketplace",
      "search:den/capabilities/skills",
    ])
  })

  test("merges sequential search results with exact ranking, limit, and coverage hint", async () => {
    const calls: string[] = []
    const statusMatch: CapabilityMatch & { readonly kind: "connection_status" } = {
      ...match("mcp:notion:*", 1),
      kind: "connection_status",
    }
    const outputs = new Map<string, readonly CapabilityMatch[]>([
      ["den/capabilities/api-catalog", [match("zeta", 100)]],
      ["den/capabilities/platform-admin", [match("bravo", 8)]],
      ["den/capabilities/external-mcp", [statusMatch]],
      ["den/capabilities/marketplace", [match("alpha", 8)]],
      ["den/capabilities/skills", [match("skill:guide", 7)]],
    ])
    const host = ready(bundledContributions((sourceDescriptor) => ({
      search: async () => {
        calls.push(sourceDescriptor.id)
        return {
          matches: outputs.get(sourceDescriptor.id) ?? [],
          ...(sourceDescriptor.id === "den/capabilities/external-mcp"
            ? { coverageHint: "External MCP search inspected 16 of 17 eligible connections." }
            : {}),
        }
      },
    })))

    const result = await host.search({ query: "work", limit: 3, type: "all" })

    expect(calls).toEqual([
      "den/capabilities/api-catalog",
      "den/capabilities/platform-admin",
      "den/capabilities/external-mcp",
      "den/capabilities/marketplace",
      "den/capabilities/skills",
    ])
    expect(result.matches.map((item) => item.name)).toEqual([
      "mcp:notion:*",
      "zeta",
      "alpha",
    ])
    expect(result.coverageHint).toBe(
      "External MCP search inspected 16 of 17 eligible connections.",
    )
  })

  test("dispatches execution in legacy precedence and returns unknown without guessing", async () => {
    const calls: string[] = []
    const handledBy = "den/capabilities/marketplace"
    const host = ready(bundledContributions((sourceDescriptor) => ({
      search: async () => ({ matches: [] }),
      execute: async () => {
        calls.push(sourceDescriptor.id)
        return sourceDescriptor.id === handledBy
          ? { status: "handled", result: "marketplace-result" }
          : { status: "unhandled" }
      },
    })))

    await expect(host.execute({ name: "marketplace:plugin:object" })).resolves.toEqual({
      status: "handled",
      result: "marketplace-result",
    })
    expect(calls).toEqual([
      "den/capabilities/platform-admin",
      "den/capabilities/external-mcp",
      "den/capabilities/marketplace",
    ])

    calls.length = 0
    const unknownHost = ready(bundledContributions((sourceDescriptor) =>
      inertRuntime(sourceDescriptor.id, calls)))
    await expect(unknownHost.execute({ name: "not-real" })).resolves.toEqual({
      status: "unhandled",
    })
    expect(calls).toEqual([
      "execute:den/capabilities/platform-admin",
      "execute:den/capabilities/external-mcp",
      "execute:den/capabilities/marketplace",
      "execute:den/capabilities/skills",
      "execute:den/capabilities/api-catalog",
    ])
  })

  test("does not swallow provider execution errors or continue dispatch", async () => {
    const calls: string[] = []
    const host = ready(bundledContributions((sourceDescriptor) => ({
      search: async () => ({ matches: [] }),
      execute: async () => {
        calls.push(sourceDescriptor.id)
        if (sourceDescriptor.id === "den/capabilities/external-mcp") {
          throw new Error("provider transport failed")
        }
        return { status: "unhandled" }
      },
    })))

    await expect(host.execute({ name: "mcp:test:tool" })).rejects.toThrow(
      "provider transport failed",
    )
    expect(calls).toEqual([
      "den/capabilities/platform-admin",
      "den/capabilities/external-mcp",
    ])
  })

  test("does not swallow provider search errors or continue the merge", async () => {
    const calls: string[] = []
    const host = ready(bundledContributions((sourceDescriptor) => ({
      search: async () => {
        calls.push(sourceDescriptor.id)
        if (sourceDescriptor.id === "den/capabilities/external-mcp") {
          throw new Error("provider search failed")
        }
        return { matches: [] }
      },
    })))

    await expect(host.search({ query: "calendar", limit: 5, type: "all" }))
      .rejects.toThrow("provider search failed")
    expect(calls).toEqual([
      "den/capabilities/api-catalog",
      "den/capabilities/platform-admin",
      "den/capabilities/external-mcp",
    ])
  })

  test("rejects duplicate ids, unsupported versions, and missing dependencies before construction", () => {
    const cases: readonly {
      contributions: readonly DenCapabilitySourceContribution<TestExecutionResult>[]
      code: string
    }[] = [
      {
        contributions: [
          contribution(descriptor({ id: "test/duplicate", order: 1 }), inertRuntime("one")),
          contribution(descriptor({ id: "test/duplicate", order: 2 }), inertRuntime("two")),
        ],
        code: "duplicate-id",
      },
      {
        contributions: [contribution(descriptor({
          id: "test/future",
          order: 1,
          contractVersion: DEN_CAPABILITY_SOURCE_CONTRACT_VERSION + 1,
        }), inertRuntime("future"))],
        code: "unsupported-contract-version",
      },
      {
        contributions: [contribution(descriptor({
          id: "test/dependent",
          order: 1,
          requires: ["test/missing"],
        }), inertRuntime("dependent"))],
        code: "missing-requirement",
      },
    ]

    for (const fixture of cases) {
      let constructions = 0
      const result = composeDenCapabilitySources(fixture.contributions.map((item) => ({
        descriptor: item.descriptor,
        binding: {
          status: "ready",
          create: () => {
            constructions += 1
            return inertRuntime("must-not-run")
          },
        },
      })))
      expect(result.status).toBe("invalid")
      expect(result.status === "invalid"
        ? result.diagnostics.map((item) => item.code)
        : []).toContain(fixture.code)
      expect(constructions).toBe(0)
    }
  })

  test("never exposes a partially ready host when one source construction fails", () => {
    const good = contribution(
      descriptor({ id: "test/good", order: 1 }),
      inertRuntime("good"),
    )
    const failing: DenCapabilitySourceContribution<TestExecutionResult> = {
      descriptor: descriptor({ id: "test/failing", order: 2 }),
      binding: {
        status: "ready",
        create: () => {
          throw new Error("construction failed")
        },
      },
    }

    const result = composeDenCapabilitySources([good, failing])

    expect(result).toMatchObject({
      status: "invalid",
      diagnostics: [{
        code: "source-construction-failed",
        sourceId: "test/failing",
      }],
    })
    expect("search" in result).toBe(false)
    expect("execute" in result).toBe(false)
  })

  test("supports intentional omission without hidden global registration", async () => {
    const withoutMarketplace = bundledContributions()
      .filter((item) => item.descriptor.id !== "den/capabilities/marketplace")
    const host = ready(withoutMarketplace)

    expect(host.descriptors.map((item) => item.id)).toEqual([
      "den/capabilities/api-catalog",
      "den/capabilities/platform-admin",
      "den/capabilities/external-mcp",
      "den/capabilities/skills",
    ])
    await expect(host.search({ query: "skill", limit: 5, type: "skills" }))
      .resolves.toEqual({ matches: [] })
  })

  test("adds a sixth source with one explicit assembly-list edit", async () => {
    const fakeDescriptor = descriptor({
      id: "test/capabilities/sixth",
      order: 600,
      executionOrder: 50,
      searchTypes: ["api"],
    })
    const fake = contribution(fakeDescriptor, {
      search: async () => ({ matches: [match("sixth:hello", 1)] }),
      execute: async ({ name }) => name === "sixth:hello"
        ? { status: "handled", result: "hello from sixth" }
        : { status: "unhandled" },
    })

    const host = ready([...bundledContributions(), fake])

    expect(host.descriptors.at(-1)?.id).toBe("test/capabilities/sixth")
    await expect(host.search({ query: "hello", limit: 20, type: "all" }))
      .resolves.toMatchObject({ matches: [expect.objectContaining({ name: "sixth:hello" })] })
    await expect(host.execute({ name: "sixth:hello" })).resolves.toEqual({
      status: "handled",
      result: "hello from sixth",
    })
  })
})
