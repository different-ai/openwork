import {
  CONTRIBUTION_CONTRACT_VERSION,
  type ConstructionResult,
  type ContributionAvailability,
  type ContributionBinding,
  type ContributionDescriptor,
  type ContributionEntrySnapshot,
  type ContributionRegistration,
  type ContributionRegistry,
  type ContributionRegistryOptions,
  type FreezeResult,
  type LookupResult,
  type RegisterResult,
  type RegistryDiagnostic,
  type RegistryDiagnosticCode,
  type RegistrySnapshot,
} from "./contracts.js"

interface StoredContribution<
  Descriptor extends ContributionDescriptor,
  Host,
  Runtime,
> {
  readonly descriptor: Readonly<Descriptor>
  readonly binding: ContributionBinding<Host, Runtime>
}

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0

const compareContributions = <Descriptor extends ContributionDescriptor>(
  left: Readonly<{ descriptor: Readonly<Descriptor> }>,
  right: Readonly<{ descriptor: Readonly<Descriptor> }>,
): number => {
  const orderDifference = (left.descriptor.order ?? 0) - (right.descriptor.order ?? 0)
  return orderDifference || compareText(left.descriptor.id, right.descriptor.id)
}

const frozenArray = <Value>(values: readonly Value[]): readonly Value[] =>
  Object.freeze([...values])

const diagnostic = (
  code: RegistryDiagnosticCode,
  message: string,
  contributionId?: string,
  relatedIds?: readonly string[],
): RegistryDiagnostic =>
  Object.freeze({
    severity: "error" as const,
    code,
    message,
    ...(contributionId === undefined ? {} : { contributionId }),
    ...(relatedIds === undefined ? {} : { relatedIds: frozenArray(relatedIds) }),
  })

const isSemanticId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value === value.trim() && !/\s/u.test(value)

const isNonEmptyText = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0

const validateDescriptor = <Descriptor extends ContributionDescriptor>(
  descriptor: Descriptor,
): RegistryDiagnostic | undefined => {
  if (!isSemanticId(descriptor.id)) {
    return diagnostic(
      "invalid-descriptor",
      "Contribution id must be a non-empty, whitespace-free semantic id.",
    )
  }
  if (!isNonEmptyText(descriptor.kind)) {
    return diagnostic(
      "invalid-descriptor",
      `Contribution "${descriptor.id}" must declare a non-empty kind.`,
      descriptor.id,
    )
  }
  if (!Number.isInteger(descriptor.contractVersion) || descriptor.contractVersion < 1) {
    return diagnostic(
      "invalid-descriptor",
      `Contribution "${descriptor.id}" must declare a positive integer contract version.`,
      descriptor.id,
    )
  }
  if (!isNonEmptyText(descriptor.provenance?.packageName)) {
    return diagnostic(
      "invalid-descriptor",
      `Contribution "${descriptor.id}" must declare its provenance package name.`,
      descriptor.id,
    )
  }
  if (descriptor.order !== undefined && !Number.isFinite(descriptor.order)) {
    return diagnostic(
      "invalid-descriptor",
      `Contribution "${descriptor.id}" order must be a finite number.`,
      descriptor.id,
    )
  }
  const requirements = descriptor.requires ?? []
  const invalidRequirement = requirements.find((requirement) => !isSemanticId(requirement))
  if (invalidRequirement !== undefined) {
    return diagnostic(
      "invalid-descriptor",
      `Contribution "${descriptor.id}" has an invalid requirement id.`,
      descriptor.id,
    )
  }
  if (new Set(requirements).size !== requirements.length) {
    return diagnostic(
      "invalid-descriptor",
      `Contribution "${descriptor.id}" must not repeat requirement ids.`,
      descriptor.id,
    )
  }
  return undefined
}

const validateBinding = <Host, Runtime>(
  id: string,
  binding: ContributionBinding<Host, Runtime>,
): RegistryDiagnostic | undefined => {
  if (binding.status === "ready") {
    return typeof binding.create === "function"
      ? undefined
      : diagnostic(
          "invalid-binding",
          `Ready contribution "${id}" must provide a create factory.`,
          id,
        )
  }
  return isNonEmptyText(binding.reason)
    ? undefined
    : diagnostic(
        "invalid-binding",
        `${binding.status === "disabled" ? "Disabled" : "Unavailable"} contribution "${id}" must provide a reason.`,
        id,
      )
}

class DescriptorSerializationError extends Error {
  readonly path: string

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`)
    this.name = "DescriptorSerializationError"
    this.path = path
  }
}

const childPath = (parent: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key)
    ? `${parent}.${key}`
    : `${parent}[${JSON.stringify(key)}]`

const cloneSerializableValue = (
  value: unknown,
  path: string,
  active: WeakSet<object>,
  completed: WeakMap<object, unknown>,
): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DescriptorSerializationError(path, "numbers must be finite")
    }
    return value
  }
  if (typeof value !== "object") {
    throw new DescriptorSerializationError(
      path,
      `${typeof value} values are not serializable`,
    )
  }
  if (active.has(value)) {
    throw new DescriptorSerializationError(path, "cyclic references are not serializable")
  }
  const existing = completed.get(value)
  if (existing !== undefined) return existing

  active.add(value)
  if (Array.isArray(value)) {
    const ownKeys = Reflect.ownKeys(value)
    const allowedKeys = new Set<string>(["length"])
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new DescriptorSerializationError(path, "sparse arrays are not supported")
      }
      allowedKeys.add(String(index))
    }
    const extraKey = ownKeys.find(
      (key) => typeof key !== "string" || !allowedKeys.has(key),
    )
    if (extraKey !== undefined) {
      throw new DescriptorSerializationError(path, "array properties must be indexed values")
    }

    const copy: unknown[] = []
    completed.set(value, copy)
    for (let index = 0; index < value.length; index += 1) {
      const property = Object.getOwnPropertyDescriptor(value, String(index))
      if (property === undefined || !("value" in property) || !property.enumerable) {
        throw new DescriptorSerializationError(
          `${path}[${index}]`,
          "accessor and non-enumerable values are not supported",
        )
      }
      copy.push(
        cloneSerializableValue(property.value, `${path}[${index}]`, active, completed),
      )
    }
    active.delete(value)
    return Object.freeze(copy)
  }

  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DescriptorSerializationError(
      path,
      "only plain objects and arrays are supported",
    )
  }

  const copy: Record<string, unknown> = Object.create(
    prototype === null ? null : Object.prototype,
  ) as Record<string, unknown>
  completed.set(value, copy)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new DescriptorSerializationError(path, "symbol properties are not serializable")
    }
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (property === undefined || !("value" in property) || !property.enumerable) {
      throw new DescriptorSerializationError(
        childPath(path, key),
        "accessor and non-enumerable values are not supported",
      )
    }
    copy[key] = cloneSerializableValue(
      property.value,
      childPath(path, key),
      active,
      completed,
    )
  }
  active.delete(value)
  return Object.freeze(copy)
}

type DescriptorCopyResult<Descriptor extends ContributionDescriptor> =
  | Readonly<{ status: "copied"; descriptor: Readonly<Descriptor> }>
  | Readonly<{ status: "rejected"; diagnostic: RegistryDiagnostic }>

const copyDescriptor = <Descriptor extends ContributionDescriptor>(
  descriptor: Descriptor,
): DescriptorCopyResult<Descriptor> => {
  try {
    return Object.freeze({
      status: "copied",
      descriptor: cloneSerializableValue(
        descriptor,
        "$",
        new WeakSet(),
        new WeakMap(),
      ) as Readonly<Descriptor>,
    })
  } catch (cause) {
    const detail =
      cause instanceof DescriptorSerializationError
        ? cause.message
        : "descriptor metadata could not be inspected safely"
    return Object.freeze({
      status: "rejected",
      diagnostic: diagnostic(
        "invalid-descriptor",
        `Contribution "${descriptor.id}" has non-serializable metadata (${detail}).`,
        descriptor.id,
      ),
    })
  }
}

const copyBinding = <Host, Runtime>(
  binding: ContributionBinding<Host, Runtime>,
): ContributionBinding<Host, Runtime> => Object.freeze({ ...binding })

const availabilityOf = <Host, Runtime>(
  binding: ContributionBinding<Host, Runtime>,
): ContributionAvailability =>
  binding.status === "ready"
    ? Object.freeze({ status: "ready" })
    : Object.freeze({ status: binding.status, reason: binding.reason })

const entrySnapshot = <
  Descriptor extends ContributionDescriptor,
  Host,
  Runtime,
>(
  entry: StoredContribution<Descriptor, Host, Runtime>,
): ContributionEntrySnapshot<Descriptor> =>
  Object.freeze({
    descriptor: entry.descriptor,
    availability: availabilityOf(entry.binding),
  })

const findCyclicComponents = <
  Descriptor extends ContributionDescriptor,
  Host,
  Runtime,
>(
  entriesById: ReadonlyMap<string, StoredContribution<Descriptor, Host, Runtime>>,
): readonly (readonly string[])[] => {
  let nextIndex = 0
  const indexes = new Map<string, number>()
  const lowLinks = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const components: string[][] = []

  const visit = (id: string): void => {
    indexes.set(id, nextIndex)
    lowLinks.set(id, nextIndex)
    nextIndex += 1
    stack.push(id)
    onStack.add(id)

    const requirements = [...(entriesById.get(id)?.descriptor.requires ?? [])]
      .filter((requirement) => entriesById.has(requirement))
      .sort(compareText)

    for (const requirement of requirements) {
      if (!indexes.has(requirement)) {
        visit(requirement)
        lowLinks.set(
          id,
          Math.min(lowLinks.get(id) ?? 0, lowLinks.get(requirement) ?? 0),
        )
      } else if (onStack.has(requirement)) {
        lowLinks.set(
          id,
          Math.min(lowLinks.get(id) ?? 0, indexes.get(requirement) ?? 0),
        )
      }
    }

    if (lowLinks.get(id) !== indexes.get(id)) return

    const component: string[] = []
    let member: string | undefined
    do {
      member = stack.pop()
      if (member === undefined) break
      onStack.delete(member)
      component.push(member)
    } while (member !== id)

    const isSelfCycle =
      component.length === 1 &&
      entriesById.get(component[0] ?? "")?.descriptor.requires?.includes(component[0] ?? "")
    if (component.length > 1 || isSelfCycle) {
      components.push(component.sort(compareText))
    }
  }

  for (const id of [...entriesById.keys()].sort(compareText)) {
    if (!indexes.has(id)) visit(id)
  }

  components.sort((left, right) => compareText(left[0] ?? "", right[0] ?? ""))
  return frozenArray(components.map((component) => frozenArray(component)))
}

const orderEntries = <
  Descriptor extends ContributionDescriptor,
  Host,
  Runtime,
>(
  entriesById: ReadonlyMap<string, StoredContribution<Descriptor, Host, Runtime>>,
): readonly StoredContribution<Descriptor, Host, Runtime>[] => {
  const indegrees = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const id of entriesById.keys()) {
    indegrees.set(id, 0)
    dependents.set(id, [])
  }

  for (const entry of entriesById.values()) {
    for (const requirement of entry.descriptor.requires ?? []) {
      if (!entriesById.has(requirement)) continue
      indegrees.set(entry.descriptor.id, (indegrees.get(entry.descriptor.id) ?? 0) + 1)
      dependents.get(requirement)?.push(entry.descriptor.id)
    }
  }

  const ready = [...entriesById.values()]
    .filter((entry) => indegrees.get(entry.descriptor.id) === 0)
    .sort(compareContributions)
  const ordered: StoredContribution<Descriptor, Host, Runtime>[] = []

  while (ready.length > 0) {
    const entry = ready.shift()
    if (entry === undefined) break
    ordered.push(entry)
    for (const dependent of dependents.get(entry.descriptor.id) ?? []) {
      const nextIndegree = (indegrees.get(dependent) ?? 0) - 1
      indegrees.set(dependent, nextIndegree)
      if (nextIndegree === 0) {
        const dependentEntry = entriesById.get(dependent)
        if (dependentEntry !== undefined) {
          ready.push(dependentEntry)
          ready.sort(compareContributions)
        }
      }
    }
  }

  if (ordered.length < entriesById.size) {
    const orderedIds = new Set(ordered.map((entry) => entry.descriptor.id))
    ordered.push(
      ...[...entriesById.values()]
        .filter((entry) => !orderedIds.has(entry.descriptor.id))
        .sort(compareContributions),
    )
  }

  return frozenArray(ordered)
}

class ContributionRegistryImplementation<
  Descriptor extends ContributionDescriptor,
  Host,
  Runtime,
> implements ContributionRegistry<Descriptor, Host, Runtime>
{
  readonly #entries = new Map<
    string,
    StoredContribution<Descriptor, Host, Runtime>
  >()
  readonly #supportedContractVersions: ReadonlySet<number>
  readonly #assemblyDiagnostics: RegistryDiagnostic[] = []
  #freezeResult: FreezeResult<Descriptor> | undefined

  constructor(options: ContributionRegistryOptions) {
    const versions = options.supportedContractVersions ?? [CONTRIBUTION_CONTRACT_VERSION]
    if (
      versions.length === 0 ||
      versions.some((version) => !Number.isInteger(version) || version < 1)
    ) {
      throw new TypeError(
        "supportedContractVersions must contain at least one positive integer.",
      )
    }
    this.#supportedContractVersions = new Set(versions)
  }

  get isFrozen(): boolean {
    return this.#freezeResult !== undefined
  }

  register(
    descriptor: Descriptor,
    binding: ContributionBinding<Host, Runtime>,
  ): RegisterResult<Descriptor> {
    if (this.isFrozen) {
      return Object.freeze({
        status: "rejected",
        diagnostic: diagnostic(
          "registration-frozen",
          `Contribution "${descriptor.id}" cannot be registered after the registry is frozen.`,
          descriptor.id,
        ),
      })
    }

    const descriptorIssue = validateDescriptor(descriptor)
    if (descriptorIssue !== undefined) return this.#reject(descriptorIssue)

    if (!this.#supportedContractVersions.has(descriptor.contractVersion)) {
      return this.#reject(
        diagnostic(
          "unsupported-contract-version",
          `Contribution "${descriptor.id}" uses unsupported contract version ${descriptor.contractVersion}.`,
          descriptor.id,
        ),
      )
    }

    if (this.#entries.has(descriptor.id)) {
      return this.#reject(
        diagnostic(
          "duplicate-id",
          `Contribution id "${descriptor.id}" is already registered.`,
          descriptor.id,
        ),
      )
    }

    const bindingIssue = validateBinding(descriptor.id, binding)
    if (bindingIssue !== undefined) return this.#reject(bindingIssue)

    const descriptorCopy = copyDescriptor(descriptor)
    if (descriptorCopy.status === "rejected") {
      return this.#reject(descriptorCopy.diagnostic)
    }
    const storedDescriptor = descriptorCopy.descriptor
    this.#entries.set(descriptor.id, {
      descriptor: storedDescriptor,
      binding: copyBinding(binding),
    })
    return Object.freeze({ status: "registered", descriptor: storedDescriptor })
  }

  registerAll(
    registrations: readonly ContributionRegistration<Descriptor, Host, Runtime>[],
  ): readonly RegisterResult<Descriptor>[] {
    return frozenArray(
      registrations.map(({ descriptor, binding }) => this.register(descriptor, binding)),
    )
  }

  freeze(): FreezeResult<Descriptor> {
    if (this.#freezeResult !== undefined) return this.#freezeResult

    const diagnostics = [...this.#assemblyDiagnostics]
    for (const entry of [...this.#entries.values()].sort(compareContributions)) {
      for (const requirement of [...(entry.descriptor.requires ?? [])].sort(compareText)) {
        if (!this.#entries.has(requirement)) {
          diagnostics.push(
            diagnostic(
              "missing-requirement",
              `Contribution "${entry.descriptor.id}" requires missing contribution "${requirement}".`,
              entry.descriptor.id,
              [requirement],
            ),
          )
        }
      }
    }

    for (const cycle of findCyclicComponents(this.#entries)) {
      diagnostics.push(
        diagnostic(
          "dependency-cycle",
          `Contribution dependency cycle detected: ${cycle.join(" -> ")}.`,
          cycle[0],
          cycle,
        ),
      )
    }

    const frozenDiagnostics = frozenArray(diagnostics)
    const snapshot: RegistrySnapshot<Descriptor> = Object.freeze({
      phase: "frozen",
      valid: frozenDiagnostics.length === 0,
      entries: frozenArray(orderEntries(this.#entries).map(entrySnapshot)),
      diagnostics: frozenDiagnostics,
    })
    this.#freezeResult = Object.freeze({
      status: snapshot.valid ? "ready" : "invalid",
      snapshot,
    }) as FreezeResult<Descriptor>
    return this.#freezeResult
  }

  lookup(id: string): LookupResult<Descriptor> {
    const entry = this.#entries.get(id)
    return entry === undefined
      ? Object.freeze({ status: "unknown", id })
      : Object.freeze({
          status: "found",
          descriptor: entry.descriptor,
          availability: availabilityOf(entry.binding),
        })
  }

  construct(id: string, host: Host): ConstructionResult<Descriptor, Runtime> {
    if (this.#freezeResult?.status !== "ready") {
      return Object.freeze({
        status: "registry-not-ready",
        id,
        diagnostics: this.diagnostics(),
      })
    }

    const entry = this.#entries.get(id)
    if (entry === undefined) return Object.freeze({ status: "unknown", id })
    if (entry.binding.status !== "ready") {
      return Object.freeze({
        status: entry.binding.status,
        descriptor: entry.descriptor,
        reason: entry.binding.reason,
      })
    }

    try {
      return Object.freeze({
        status: "constructed",
        descriptor: entry.descriptor,
        value: entry.binding.create(host),
      })
    } catch (cause) {
      return Object.freeze({
        status: "failed",
        descriptor: entry.descriptor,
        cause,
      })
    }
  }

  constructAll(host: Host): readonly ConstructionResult<Descriptor, Runtime>[] {
    return frozenArray(
      this.snapshot().entries.map(({ descriptor }) => this.construct(descriptor.id, host)),
    )
  }

  snapshot(): RegistrySnapshot<Descriptor> {
    if (this.#freezeResult !== undefined) return this.#freezeResult.snapshot
    const entries = [...this.#entries.values()].sort(compareContributions)
    return Object.freeze({
      phase: "assembling",
      valid: false,
      entries: frozenArray(entries.map(entrySnapshot)),
      diagnostics: this.diagnostics(),
    })
  }

  diagnostics(): readonly RegistryDiagnostic[] {
    return this.#freezeResult?.snapshot.diagnostics ?? frozenArray(this.#assemblyDiagnostics)
  }

  #reject(issue: RegistryDiagnostic): RegisterResult<Descriptor> {
    this.#assemblyDiagnostics.push(issue)
    return Object.freeze({ status: "rejected", diagnostic: issue })
  }
}

export const createContributionRegistry = <
  Descriptor extends ContributionDescriptor,
  Host,
  Runtime,
>(
  options: ContributionRegistryOptions = {},
): ContributionRegistry<Descriptor, Host, Runtime> =>
  new ContributionRegistryImplementation<Descriptor, Host, Runtime>(options)
