import {
  CONTRIBUTION_CONTRACT_VERSION,
  createContributionRegistry,
  type ContributionBinding,
  type ContributionDescriptor,
  type RegistryDiagnostic,
  type RegistryDiagnosticCode,
} from "@openwork/contribution-registry"
import {
  compareCapabilityMatches,
  type CapabilityMatch,
  type SearchCapabilityType,
} from "./search.js"

export const DEN_CAPABILITY_SOURCE_CONTRACT_VERSION = CONTRIBUTION_CONTRACT_VERSION

export type DenCapabilitySearchType = Exclude<SearchCapabilityType, "all">

export interface DenCapabilitySourceDescriptor extends ContributionDescriptor {
  readonly kind: "den-capability-source"
  /** Search filters that select this source. The `all` filter is implicit. */
  readonly searchTypes: readonly DenCapabilitySearchType[]
  /** Dispatch precedence is distinct from search merge order. */
  readonly executionOrder: number
  readonly purpose: string
}

export interface DenCapabilitySourceSearchInput {
  readonly query: string
  readonly limit: number
  readonly type?: SearchCapabilityType
}

export interface DenCapabilitySourceSearchResult {
  readonly matches: readonly CapabilityMatch[]
  readonly coverageHint?: string
}

export interface DenCapabilitySourceExecutionInput {
  readonly name: string
  readonly path?: unknown
  readonly query?: unknown
  readonly body?: unknown
}

export type DenCapabilitySourceExecutionResult<Result> =
  | Readonly<{ status: "handled"; result: Result }>
  | Readonly<{ status: "unhandled" }>

/** The only runtime seam shared by Den capability providers. */
export interface DenCapabilitySourceRuntime<Result> {
  readonly search: (
    input: DenCapabilitySourceSearchInput,
  ) => Promise<DenCapabilitySourceSearchResult>
  readonly execute?: (
    input: DenCapabilitySourceExecutionInput,
  ) => Promise<DenCapabilitySourceExecutionResult<Result>>
}

/** Serializable metadata and executable bindings deliberately stay separate. */
export interface DenCapabilitySourceContribution<Result> {
  readonly descriptor: DenCapabilitySourceDescriptor
  readonly binding: ContributionBinding<undefined, DenCapabilitySourceRuntime<Result>>
}

export interface DenCapabilitySourceCompositionDiagnostic {
  readonly severity: "error"
  readonly code:
    | RegistryDiagnosticCode
    | "source-construction-failed"
    | "source-disabled"
    | "source-unavailable"
  readonly message: string
  readonly sourceId?: string
  readonly relatedIds?: readonly string[]
}

export type DenCapabilitySourceCompositionResult<Result> =
  | Readonly<{
      status: "ready"
      descriptors: readonly Readonly<DenCapabilitySourceDescriptor>[]
      search: (
        input: DenCapabilitySourceSearchInput,
      ) => Promise<DenCapabilitySourceSearchResult>
      execute: (
        input: DenCapabilitySourceExecutionInput,
      ) => Promise<DenCapabilitySourceExecutionResult<Result>>
    }>
  | Readonly<{
      status: "invalid"
      descriptors: readonly Readonly<DenCapabilitySourceDescriptor>[]
      diagnostics: readonly DenCapabilitySourceCompositionDiagnostic[]
    }>

const DEN_CAPABILITY_SOURCE_PROVENANCE = Object.freeze({
  packageName: "@openwork-ee/den-api",
  source: "src/mcp/capability-source-composition.ts",
})

function bundledDescriptor(input: {
  id: string
  order: number
  executionOrder: number
  searchTypes: readonly DenCapabilitySearchType[]
  purpose: string
}): DenCapabilitySourceDescriptor {
  return Object.freeze({
    id: input.id,
    kind: "den-capability-source",
    contractVersion: DEN_CAPABILITY_SOURCE_CONTRACT_VERSION,
    provenance: DEN_CAPABILITY_SOURCE_PROVENANCE,
    order: input.order,
    executionOrder: input.executionOrder,
    searchTypes: Object.freeze([...input.searchTypes]),
    purpose: input.purpose,
  })
}

/**
 * Search order preserves the legacy merge sequence. Execution order preserves
 * the separate legacy name-dispatch precedence.
 */
export const BUNDLED_DEN_CAPABILITY_SOURCE_DESCRIPTORS = Object.freeze({
  api: bundledDescriptor({
    id: "den/capabilities/api-catalog",
    order: 100,
    executionOrder: 500,
    searchTypes: ["api"],
    purpose: "Search and invoke the Den REST/OpenAPI operation catalog.",
  }),
  admin: bundledDescriptor({
    id: "den/capabilities/platform-admin",
    order: 200,
    executionOrder: 100,
    searchTypes: ["admin"],
    purpose: "Expose namespaced platform-admin operations to allowlisted administrators.",
  }),
  externalMcp: bundledDescriptor({
    id: "den/capabilities/external-mcp",
    order: 300,
    executionOrder: 200,
    searchTypes: ["mcp"],
    purpose: "Search and execute organization-connected external MCP tools.",
  }),
  marketplace: bundledDescriptor({
    id: "den/capabilities/marketplace",
    order: 400,
    executionOrder: 300,
    searchTypes: ["marketplace", "skills"],
    purpose: "Search and execute installable marketplace capability objects.",
  }),
  skills: bundledDescriptor({
    id: "den/capabilities/skills",
    order: 500,
    executionOrder: 400,
    searchTypes: ["skills"],
    purpose: "Search organization skills and return their stored SKILL.md content.",
  }),
})

interface ConstructedSource<Result> {
  readonly descriptor: Readonly<DenCapabilitySourceDescriptor>
  readonly runtime: DenCapabilitySourceRuntime<Result>
}

const frozenArray = <Value>(values: readonly Value[]): readonly Value[] =>
  Object.freeze([...values])

function diagnostic(
  code: DenCapabilitySourceCompositionDiagnostic["code"],
  message: string,
  sourceId?: string,
  relatedIds?: readonly string[],
): DenCapabilitySourceCompositionDiagnostic {
  return Object.freeze({
    severity: "error",
    code,
    message,
    ...(sourceId === undefined ? {} : { sourceId }),
    ...(relatedIds === undefined ? {} : { relatedIds: frozenArray(relatedIds) }),
  })
}

function fromRegistryDiagnostic(
  issue: RegistryDiagnostic,
): DenCapabilitySourceCompositionDiagnostic {
  return diagnostic(issue.code, issue.message, issue.contributionId, issue.relatedIds)
}

function failureMessage(cause: unknown): string {
  return cause instanceof Error && cause.message.trim()
    ? cause.message.trim()
    : "Unknown source construction failure"
}

function sourceMatchesSearchType(
  descriptor: Readonly<DenCapabilitySourceDescriptor>,
  type?: SearchCapabilityType,
): boolean {
  return type === undefined || type === "all" || descriptor.searchTypes.includes(type)
}

function byExecutionOrder<Result>(
  left: ConstructedSource<Result>,
  right: ConstructedSource<Result>,
): number {
  return left.descriptor.executionOrder - right.descriptor.executionOrder
    || left.descriptor.id.localeCompare(right.descriptor.id)
}

/**
 * Assemble one request-local Den capability host. Registry failures are
 * resolved before any source factory runs, and construction failures never
 * yield a partially ready host.
 */
export function composeDenCapabilitySources<Result>(
  contributions: readonly DenCapabilitySourceContribution<Result>[],
): DenCapabilitySourceCompositionResult<Result> {
  const registry = createContributionRegistry<
    DenCapabilitySourceDescriptor,
    undefined,
    DenCapabilitySourceRuntime<Result>
  >({ supportedContractVersions: [DEN_CAPABILITY_SOURCE_CONTRACT_VERSION] })

  registry.registerAll(contributions)
  const frozen = registry.freeze()
  const descriptors = frozenArray(
    frozen.snapshot.entries.map((entry) => entry.descriptor),
  )
  if (frozen.status === "invalid") {
    return Object.freeze({
      status: "invalid",
      descriptors,
      diagnostics: frozenArray(
        frozen.snapshot.diagnostics.map(fromRegistryDiagnostic),
      ),
    })
  }

  const sources: ConstructedSource<Result>[] = []
  const diagnostics: DenCapabilitySourceCompositionDiagnostic[] = []
  for (const result of registry.constructAll(undefined)) {
    if (result.status === "constructed") {
      sources.push(Object.freeze({
        descriptor: result.descriptor,
        runtime: result.value,
      }))
      continue
    }

    if (result.status === "disabled") {
      diagnostics.push(diagnostic(
        "source-disabled",
        `Capability source "${result.descriptor.id}" is disabled: ${result.reason}`,
        result.descriptor.id,
      ))
      continue
    }
    if (result.status === "unavailable") {
      diagnostics.push(diagnostic(
        "source-unavailable",
        `Capability source "${result.descriptor.id}" is unavailable: ${result.reason}`,
        result.descriptor.id,
      ))
      continue
    }
    if (result.status === "failed") {
      diagnostics.push(diagnostic(
        "source-construction-failed",
        `Capability source "${result.descriptor.id}" failed to construct: ${failureMessage(result.cause)}.`,
        result.descriptor.id,
      ))
      continue
    }

    diagnostics.push(diagnostic(
      "source-construction-failed",
      `Capability source "${result.id}" could not be constructed from the frozen registry.`,
      result.id,
    ))
  }

  if (diagnostics.length > 0) {
    return Object.freeze({
      status: "invalid",
      descriptors,
      diagnostics: frozenArray(diagnostics),
    })
  }

  const searchSources = frozenArray(sources)
  const executionSources = frozenArray([...sources].sort(byExecutionOrder))

  return Object.freeze({
    status: "ready",
    descriptors,
    search: async (
      input: DenCapabilitySourceSearchInput,
    ): Promise<DenCapabilitySourceSearchResult> => {
      const matches: CapabilityMatch[] = []
      const coverageHints: string[] = []
      for (const source of searchSources) {
        if (!sourceMatchesSearchType(source.descriptor, input.type)) continue
        const result = await source.runtime.search(input)
        matches.push(...result.matches)
        if (result.coverageHint) coverageHints.push(result.coverageHint)
      }

      const boundedMatches = matches
        .sort(compareCapabilityMatches)
        .slice(0, input.limit)
      const coverageHint = coverageHints.join(" ")
      return Object.freeze({
        matches: frozenArray(boundedMatches),
        ...(coverageHint ? { coverageHint } : {}),
      })
    },
    execute: async (
      input: DenCapabilitySourceExecutionInput,
    ): Promise<DenCapabilitySourceExecutionResult<Result>> => {
      for (const source of executionSources) {
        if (source.runtime.execute === undefined) continue
        const result = await source.runtime.execute(input)
        if (result.status === "handled") return result
      }
      return Object.freeze({ status: "unhandled" })
    },
  })
}
