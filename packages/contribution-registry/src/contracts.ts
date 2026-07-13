export const CONTRIBUTION_CONTRACT_VERSION = 1 as const

export interface ContributionProvenance {
  readonly packageName: string
  readonly packageVersion?: string
  readonly source?: string
}

/**
 * Serializable identity and compatibility metadata interpreted by a host.
 * Runtime values, secrets, and framework objects do not belong here.
 */
export interface ContributionDescriptor {
  readonly id: string
  readonly kind: string
  readonly contractVersion: number
  readonly provenance: ContributionProvenance
  readonly order?: number
  readonly requires?: readonly string[]
}

export interface ReadyContributionBinding<Host, Runtime> {
  readonly status: "ready"
  readonly create: (host: Host) => Runtime
}

export interface DisabledContributionBinding {
  readonly status: "disabled"
  readonly reason: string
}

export interface UnavailableContributionBinding {
  readonly status: "unavailable"
  readonly reason: string
}

/** Executable bindings stay separate from serializable descriptors. */
export type ContributionBinding<Host, Runtime> =
  | ReadyContributionBinding<Host, Runtime>
  | DisabledContributionBinding
  | UnavailableContributionBinding

export interface ContributionRegistration<
  Descriptor extends ContributionDescriptor,
  Host,
  Runtime,
> {
  readonly descriptor: Descriptor
  readonly binding: ContributionBinding<Host, Runtime>
}

export type ContributionAvailability =
  | Readonly<{ status: "ready" }>
  | Readonly<{ status: "disabled"; reason: string }>
  | Readonly<{ status: "unavailable"; reason: string }>

export interface ContributionEntrySnapshot<
  Descriptor extends ContributionDescriptor,
> {
  readonly descriptor: Readonly<Descriptor>
  readonly availability: ContributionAvailability
}

export type RegistryDiagnosticCode =
  | "duplicate-id"
  | "unsupported-contract-version"
  | "invalid-descriptor"
  | "invalid-binding"
  | "registration-frozen"
  | "missing-requirement"
  | "dependency-cycle"

export interface RegistryDiagnostic {
  readonly severity: "error"
  readonly code: RegistryDiagnosticCode
  readonly message: string
  readonly contributionId?: string
  readonly relatedIds?: readonly string[]
}

export interface RegistrySnapshot<Descriptor extends ContributionDescriptor> {
  readonly phase: "assembling" | "frozen"
  readonly valid: boolean
  readonly entries: readonly ContributionEntrySnapshot<Descriptor>[]
  readonly diagnostics: readonly RegistryDiagnostic[]
}

export type RegisterResult<Descriptor extends ContributionDescriptor> =
  | Readonly<{
      status: "registered"
      descriptor: Readonly<Descriptor>
    }>
  | Readonly<{
      status: "rejected"
      diagnostic: RegistryDiagnostic
    }>

export type FreezeResult<Descriptor extends ContributionDescriptor> =
  | Readonly<{
      status: "ready"
      snapshot: RegistrySnapshot<Descriptor>
    }>
  | Readonly<{
      status: "invalid"
      snapshot: RegistrySnapshot<Descriptor>
    }>

export type LookupResult<Descriptor extends ContributionDescriptor> =
  | Readonly<{
      status: "found"
      descriptor: Readonly<Descriptor>
      availability: ContributionAvailability
    }>
  | Readonly<{
      status: "unknown"
      id: string
    }>

export type ConstructionResult<
  Descriptor extends ContributionDescriptor,
  Runtime,
> =
  | Readonly<{
      status: "constructed"
      descriptor: Readonly<Descriptor>
      value: Runtime
    }>
  | Readonly<{
      status: "disabled"
      descriptor: Readonly<Descriptor>
      reason: string
    }>
  | Readonly<{
      status: "unavailable"
      descriptor: Readonly<Descriptor>
      reason: string
    }>
  | Readonly<{
      status: "failed"
      descriptor: Readonly<Descriptor>
      cause: unknown
    }>
  | Readonly<{
      status: "unknown"
      id: string
    }>
  | Readonly<{
      status: "registry-not-ready"
      id: string
      diagnostics: readonly RegistryDiagnostic[]
    }>

export interface ContributionRegistryOptions {
  readonly supportedContractVersions?: readonly number[]
}

export interface ContributionRegistry<
  Descriptor extends ContributionDescriptor,
  Host,
  Runtime,
> {
  readonly isFrozen: boolean
  register(
    descriptor: Descriptor,
    binding: ContributionBinding<Host, Runtime>,
  ): RegisterResult<Descriptor>
  registerAll(
    registrations: readonly ContributionRegistration<Descriptor, Host, Runtime>[],
  ): readonly RegisterResult<Descriptor>[]
  freeze(): FreezeResult<Descriptor>
  lookup(id: string): LookupResult<Descriptor>
  construct(id: string, host: Host): ConstructionResult<Descriptor, Runtime>
  constructAll(host: Host): readonly ConstructionResult<Descriptor, Runtime>[]
  snapshot(): RegistrySnapshot<Descriptor>
  diagnostics(): readonly RegistryDiagnostic[]
}
