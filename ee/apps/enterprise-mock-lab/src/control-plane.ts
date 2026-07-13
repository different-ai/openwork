import { randomUUID } from "node:crypto"
import {
  createDefaultScenario,
  createEnterpriseMcpMockServer,
  listFaultDefinitions,
  listProviderProfiles,
  probeEnterpriseMcpMockServer,
  scenarioSchema,
  type EnterpriseMcpMockServer,
  type EnterpriseMcpScenario,
  type FaultDefinition,
  type ProviderProfile,
  type SafeTraceEvent,
} from "@openwork/enterprise-mcp-mock-server"
import {
  ControlPlaneError,
  type CreateInstanceInput,
  type EnterpriseMockLabControlPlane,
  type InstanceLifecycleState,
  type LabFault,
  type LabInstanceView,
  type LabProfile,
  type ProbeComparison,
  type SafeLabEvent,
  type UpdateScenarioInput,
} from "./contracts.js"

interface InstanceRecord {
  controller: EnterpriseMcpMockServer
  createdAt: string
  displayName: string
  disposed: boolean
  id: string
  lastError: string | null
  lastProbe: ProbeComparison | null
  lifecycle: InstanceLifecycleState
  oauthClientSecret: string
  port: number
  scenario: EnterpriseMcpScenario
  secretValues: readonly string[]
  secretsConfigured: LabInstanceView["secretsConfigured"]
  serial: Promise<void>
}

const maximumLabInstances = 32

function freezeLabValue<Value>(value: Value): Value {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value
  for (const nested of Object.values(value)) freezeLabValue(nested)
  return Object.freeze(value)
}

function normalizeProfile(profile: ProviderProfile): LabProfile {
  const providerLabel = profile.provider === "servicenow"
    ? "ServiceNow"
    : profile.provider === "microsoft"
      ? "Microsoft"
      : "Synthetic standards reference"
  return freezeLabValue({
    description: `${providerLabel} ${profile.productSurface} · ${profile.direction}`,
    fixtureVersion: profile.fixtureVersion,
    id: profile.id,
    name: profile.displayName,
    provenance: {
      aspectFidelity: profile.provenance.aspectFidelity,
      documentationUrls: profile.provenance.documentationUrls,
      fidelity: profile.provenance.fidelity,
      knownLimitations: profile.provenance.limitations,
      productSurface: profile.productSurface,
      verifiedAt: profile.provenance.verifiedAt,
    },
  })
}

function normalizeFault(fault: FaultDefinition): LabFault {
  return freezeLabValue({
    category: fault.category,
    description: fault.description,
    diagnosticLevel: fault.diagnosticLevel,
    expectedCategory: fault.category,
    expectedFirstFailedPhase: fault.phase,
    id: fault.id,
    name: fault.displayName,
    phase: fault.phase,
    profileIds: fault.applicableProfiles,
  })
}

function normalizeEvent(event: SafeTraceEvent): SafeLabEvent {
  const method = event.details.method
  return freezeLabValue({
    at: event.occurredAt,
    category: event.kind,
    correlationId: event.correlationId,
    ...(event.kind === "fault" && typeof event.details.faultId === "string" ? { faultId: event.details.faultId } : {}),
    message: event.summary,
    phase: event.phase,
    ...(typeof method === "string" ? { requestMethod: method } : {}),
  })
}

function comparisonFromProbe(result: Awaited<ReturnType<typeof probeEnterpriseMcpMockServer>>): ProbeComparison {
  const matchesExpectation =
    result.expected.outcome === result.observed.outcome &&
    result.expected.firstFailedPhase === result.observed.firstFailedPhase &&
    result.expected.category === result.observed.category
  return freezeLabValue({
    expected: result.expected,
    matchesExpectation,
    mode: result.mode,
    observed: result.observed,
    summary: matchesExpectation
      ? result.expected.outcome === "success"
        ? result.mode === "safe-read"
          ? "The probe completed OAuth, MCP initialization, the exact pinned tool-name set, schema-validity checks, and one synthetic read-only tool call."
          : result.mode === "fixture-conformance"
            ? "The probe completed OAuth, MCP initialization, the exact pinned tool-name set, and schema-validity checks. It did not execute a provider tool."
            : "The probe completed OAuth, MCP initialization, and a valid non-empty tool catalog. It did not assert the pinned catalog or execute a provider tool."
        : "The probe observed the configured failure at the expected first phase and category."
      : "The observed wire behavior differs from this scenario contract. Treat this as a mock-foundation defect before using it as product evidence.",
  })
}

function redactError(error: unknown, secretValues: readonly string[]): string {
  let message = error instanceof Error ? error.message : "The mock runtime could not complete the operation."
  for (const secret of secretValues) {
    if (secret) message = message.replaceAll(secret, "[REDACTED]")
  }
  message = message
    .replace(/(authorization|client[_ -]?secret|access[_ -]?token|refresh[_ -]?token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .slice(0, 500)
  return message || "The mock runtime could not complete the operation."
}

function scenarioForFault(
  current: EnterpriseMcpScenario,
  fault: FaultDefinition | undefined,
  nextRevision: number,
): EnterpriseMcpScenario {
  return scenarioSchema.parse({
    ...current,
    id: `${current.profileId}-${fault?.id ?? "healthy"}`,
    revision: nextRevision,
    activeFault: fault ? { id: fault.id, trigger: { occurrence: "always" as const } } : null,
    expected: fault
      ? { outcome: "failure" as const, firstFailedPhase: fault.phase, category: fault.category }
      : { outcome: "success" as const, firstFailedPhase: null, category: null },
  })
}

function requireRecord(records: ReadonlyMap<string, InstanceRecord>, id: string): InstanceRecord {
  const record = records.get(id)
  if (!record) throw new ControlPlaneError("not_found", "Mock instance not found.")
  return record
}

export class PackageBackedEnterpriseMockLab implements EnterpriseMockLabControlPlane {
  readonly #faultDefinitions = listFaultDefinitions()
  readonly #faults = freezeLabValue(this.#faultDefinitions.map(normalizeFault))
  readonly #instances = new Map<string, InstanceRecord>()
  readonly #profileDefinitions = listProviderProfiles()
  readonly #profiles = freezeLabValue(this.#profileDefinitions.map(normalizeProfile))
  readonly #reservedPorts: ReadonlySet<number>

  constructor(options: { reservedPorts?: readonly number[] } = {}) {
    this.#reservedPorts = new Set(options.reservedPorts ?? [])
  }

  catalog(): { faults: readonly LabFault[]; profiles: readonly LabProfile[] } {
    return freezeLabValue({ faults: this.#faults, profiles: this.#profiles })
  }

  async create(input: CreateInstanceInput): Promise<LabInstanceView> {
    if (this.#instances.size >= maximumLabInstances) {
      throw new ControlPlaneError("conflict", `The local lab is limited to ${maximumLabInstances} concurrent instances.`)
    }
    const profile = this.#profileDefinitions.find((candidate) => candidate.id === input.profileId)
    if (!profile) throw new ControlPlaneError("invalid_request", `Unknown provider profile '${input.profileId}'.`)
    if (
      profile.oauth.defaultRegistration === "manual" &&
      profile.oauth.defaultClientAuthenticationMethod === "client_secret_post" &&
      input.clientSecret.length < 12
    ) {
      throw new ControlPlaneError("invalid_request", `${profile.displayName} requires an OAuth client secret with at least 12 characters.`)
    }
    if (this.#reservedPorts.has(input.port)) {
      throw new ControlPlaneError("conflict", `Port ${input.port} belongs to the protected control plane and cannot host a provider data plane.`)
    }
    if ([...this.#instances.values()].some((candidate) => candidate.port === input.port)) {
      throw new ControlPlaneError("conflict", `Data-plane port ${input.port} is already reserved by another lab instance.`)
    }

    const selectedFault = input.faultId
      ? this.#faultDefinitions.find((candidate) => candidate.id === input.faultId)
      : undefined
    if (input.faultId && (!selectedFault || !selectedFault.applicableProfiles.includes(profile.id))) {
      throw new ControlPlaneError("invalid_request", `Fault '${input.faultId}' does not apply to '${profile.displayName}'.`)
    }

    const defaultScenario = createDefaultScenario(profile.id)
    const scenario = scenarioForFault(
      scenarioSchema.parse({
        ...defaultScenario,
        oauth: {
          ...defaultScenario.oauth,
          ...(input.clientId ? { clientId: input.clientId } : {}),
          ...(input.redirectUris ? { redirectUris: input.redirectUris } : {}),
        },
      }),
      selectedFault,
      1,
    )
    const controller = createEnterpriseMcpMockServer({
      host: "127.0.0.1",
      port: input.port,
      scenario,
      secrets: {
        oauthClientSecret: input.clientSecret,
      },
    })
    const record: InstanceRecord = {
      controller,
      createdAt: new Date().toISOString(),
      displayName: input.displayName,
      disposed: false,
      id: randomUUID(),
      lastError: null,
      lastProbe: null,
      lifecycle: "stopped",
      oauthClientSecret: input.clientSecret,
      port: input.port,
      scenario,
      secretValues: [input.clientSecret],
      secretsConfigured: {
        clientId: Boolean(input.clientId ?? scenario.oauth.clientId),
        clientSecret: Boolean(input.clientSecret),
      },
      serial: Promise.resolve(),
    }
    this.#instances.set(record.id, record)
    return this.#view(record)
  }

  get(id: string): LabInstanceView | undefined {
    const record = this.#instances.get(id)
    return record ? this.#view(record) : undefined
  }

  list(): readonly LabInstanceView[] {
    return freezeLabValue([...this.#instances.values()].map((record) => this.#view(record)))
  }

  async start(id: string): Promise<LabInstanceView> {
    const record = requireRecord(this.#instances, id)
    return this.#exclusive(record, async () => {
      if (record.lifecycle !== "stopped" && record.lifecycle !== "failed") {
        throw new ControlPlaneError("invalid_state", `Cannot start an instance while it is ${record.lifecycle}.`)
      }
      record.lifecycle = "starting"
      record.lastError = null
      try {
        await record.controller.start()
        record.lifecycle = "running"
      } catch (error) {
        record.lifecycle = "failed"
        record.lastError = redactError(error, record.secretValues)
        throw new ControlPlaneError("invalid_state", record.lastError)
      }
      return this.#view(record)
    })
  }

  async stop(id: string): Promise<LabInstanceView> {
    const record = requireRecord(this.#instances, id)
    return this.#exclusive(record, async () => {
      if (record.lifecycle !== "running" && record.lifecycle !== "failed") {
        throw new ControlPlaneError("invalid_state", `Cannot stop an instance while it is ${record.lifecycle}.`)
      }
      record.lifecycle = "stopping"
      try {
        await record.controller.stop()
        record.lifecycle = "stopped"
        record.lastError = null
      } catch (error) {
        record.lifecycle = "failed"
        record.lastError = redactError(error, record.secretValues)
        throw new ControlPlaneError("invalid_state", record.lastError)
      }
      return this.#view(record)
    })
  }

  async reset(id: string): Promise<LabInstanceView> {
    const record = requireRecord(this.#instances, id)
    return this.#exclusive(record, async () => {
      if (record.lifecycle === "starting" || record.lifecycle === "stopping") {
        throw new ControlPlaneError("invalid_state", `Cannot reset an instance while it is ${record.lifecycle}.`)
      }
      try {
        await record.controller.reset()
        record.lastError = null
        record.lastProbe = null
        record.lifecycle = record.controller.snapshot().status === "running" ? "running" : "stopped"
      } catch (error) {
        record.lifecycle = "failed"
        record.lastError = redactError(error, record.secretValues)
        throw new ControlPlaneError("invalid_state", record.lastError)
      }
      return this.#view(record)
    })
  }

  async probe(id: string): Promise<LabInstanceView> {
    const record = requireRecord(this.#instances, id)
    return this.#exclusive(record, async () => {
      if (record.lifecycle !== "running") {
        throw new ControlPlaneError("invalid_state", "Start the mock instance before running a protocol probe.")
      }
      try {
        const result = await probeEnterpriseMcpMockServer({
          baseUrl: record.controller.baseUrl,
          credentials: { clientSecret: record.oauthClientSecret },
          mode: "fixture-conformance",
          scenario: record.scenario,
        })
        record.lastProbe = comparisonFromProbe(result)
        record.lastError = null
      } catch (error) {
        record.lastError = redactError(error, record.secretValues)
        throw new ControlPlaneError("invalid_state", record.lastError)
      }
      return this.#view(record)
    })
  }

  async remove(id: string): Promise<void> {
    const record = requireRecord(this.#instances, id)
    await this.#exclusive(record, async () => {
      if (record.lifecycle === "starting" || record.lifecycle === "stopping") {
        throw new ControlPlaneError("invalid_state", `Cannot delete an instance while it is ${record.lifecycle}.`)
      }
      if (record.controller.snapshot().status === "running") await record.controller.stop()
      record.disposed = true
      this.#instances.delete(id)
    })
  }

  async updateScenario(id: string, input: UpdateScenarioInput): Promise<LabInstanceView> {
    const record = requireRecord(this.#instances, id)
    return this.#exclusive(record, async () => {
      if (input.expectedRevision !== record.scenario.revision) {
        throw new ControlPlaneError("conflict", `Scenario revision ${input.expectedRevision} is stale; revision ${record.scenario.revision} is current.`)
      }
      const fault = input.faultId
        ? this.#faultDefinitions.find((candidate) => candidate.id === input.faultId)
        : undefined
      if (input.faultId && (!fault || !fault.applicableProfiles.includes(record.scenario.profileId))) {
        throw new ControlPlaneError("invalid_request", `Fault '${input.faultId}' does not apply to this provider profile.`)
      }
      const next = scenarioForFault(record.scenario, fault, record.scenario.revision + 1)
      try {
        await record.controller.updateScenario(next, input.expectedRevision, {
          credentialContinuity: input.credentialContinuity ?? "reset",
        })
        record.scenario = next
        record.lastError = null
        record.lastProbe = null
      } catch (error) {
        const snapshot = record.controller.snapshot()
        record.scenario = snapshot.scenario
        record.lifecycle = snapshot.status === "running" ? "running" : "failed"
        record.lastError = redactError(error, record.secretValues)
        throw new ControlPlaneError("conflict", record.lastError)
      }
      return this.#view(record)
    })
  }

  async #exclusive<T>(record: InstanceRecord, operation: () => Promise<T>): Promise<T> {
    const previous = record.serial
    let release!: () => void
    record.serial = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      if (record.disposed || this.#instances.get(record.id) !== record) {
        throw new ControlPlaneError("not_found", "Mock instance was deleted before this operation could begin.")
      }
      return await operation()
    } finally {
      release()
    }
  }

  #view(record: InstanceRecord): LabInstanceView {
    const snapshot = record.controller.snapshot()
    const activeFault = record.scenario.activeFault
      ? this.#faults.find((fault) => fault.id === record.scenario.activeFault?.id) ?? null
      : null
    const endpoint = snapshot.baseUrl && snapshot.mcpUrl
      ? { baseUrl: snapshot.baseUrl, mcpUrl: snapshot.mcpUrl }
      : null
    return freezeLabValue({
      activeFault,
      createdAt: record.createdAt,
      displayName: record.displayName,
      endpoint,
      events: record.controller.events().map(normalizeEvent),
      id: record.id,
      lastError: record.lastError,
      lastProbe: record.lastProbe,
      oauth: {
        authorizationServerUrl: snapshot.oauth.authorizationServerUrl,
        clientId: snapshot.oauth.clientId,
        protectedResourceMetadataUrl: snapshot.oauth.protectedResourceMetadataUrl,
        redirectUris: record.scenario.oauth.redirectUris,
        registration: snapshot.oauth.registration,
      },
      port: record.port,
      profile: normalizeProfile(snapshot.profile),
      scenarioRevision: record.scenario.revision,
      secretsConfigured: record.secretsConfigured,
      state: record.lifecycle,
    })
  }
}
