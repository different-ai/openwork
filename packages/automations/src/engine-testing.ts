import {
  automationRevisionSchema,
  automationRunSchema,
  automationSchema,
  type AutomationError,
  type AutomationRunEventType,
  type AutomationUsage,
} from "@openwork/types/automations"
import {
  automationEngineAdmissionReceiptSchema,
  automationEngineAdmissionRequestSchema,
  automationEngineCancellationResultSchema,
  automationEngineCapabilityDeclarationSchema,
  automationEngineEventSchema,
  automationEnginePendingResultSchema,
  automationEngineReadResultSchema,
  automationEngineResultSchema,
  createAutomationEngineEventSequenceValidator,
  type AutomationEngineAdapter,
  type AutomationEngineAdmissionReceipt,
  type AutomationEngineAdmissionRequest,
  type AutomationEngineCapabilityDeclaration,
  type AutomationEngineEvent,
  type AutomationEngineExecutionState,
  type AutomationEngineResult,
} from "./engine.js"

type StoredExecution = {
  request: AutomationEngineAdmissionRequest
  receipt: AutomationEngineAdmissionReceipt
  events: AutomationEngineEvent[]
  state: AutomationEngineExecutionState
  result: AutomationEngineResult | null
  updatedAt: number
}

export interface FakeAutomationEngineHarness {
  adapter: AutomationEngineAdapter
  emit(input: {
    receipt: AutomationEngineAdmissionReceipt
    type: AutomationRunEventType
    payload: Record<string, unknown>
    createdAt: number
  }): AutomationEngineEvent
  complete(input: {
    receipt: AutomationEngineAdmissionReceipt
    status: "succeeded" | "failed" | "cancelled"
    threadId: string | null
    resultSummary: string | null
    usage: AutomationUsage
    error: AutomationError | null
    finishedAt: number
  }): AutomationEngineResult
}

function fakeCapabilities(input?: {
  adapterId?: string
  cancellation?: AutomationEngineCapabilityDeclaration["cancellation"]
}) {
  return automationEngineCapabilityDeclarationSchema.parse({
    adapterId: input?.adapterId ?? "fake-automation-engine",
    protocolVersion: 1,
    admission: "idempotent",
    reattachment: "receipt",
    eventDelivery: "ordered_at_least_once",
    resultPersistence: "durable",
    cancellation: input?.cancellation ?? "supported",
    isolation: {
      location: "cloud",
      filesystem: "none",
      shell: false,
      browser: false,
      computer: false,
      connect: "run-scoped",
      network: "provider-and-connect-only",
    },
  })
}

export function createFakeAutomationEngineAdapter(input?: {
  adapterId?: string
  cancellation?: AutomationEngineCapabilityDeclaration["cancellation"]
  now?: () => number
}): FakeAutomationEngineHarness {
  const capabilities = fakeCapabilities(input)
  const now = input?.now ?? Date.now
  const executions = new Map<string, StoredExecution>()
  const admissions = new Map<string, string>()
  let nextExecution = 1

  function stored(receipt: AutomationEngineAdmissionReceipt): StoredExecution | null {
    if (receipt.adapterId !== capabilities.adapterId) return null
    const execution = executions.get(receipt.executionId)
    if (!execution || execution.receipt.runId !== receipt.runId) return null
    return execution
  }

  function appendEvent(
    execution: StoredExecution,
    input: {
      type: AutomationRunEventType
      payload: Record<string, unknown>
      createdAt: number
    },
  ): AutomationEngineEvent {
    if (execution.result) throw new Error("Cannot append an event after a terminal result")
    const sequence = execution.events.length + 1
    const event = automationEngineEventSchema.parse({
      id: `${execution.receipt.executionId}:event:${sequence}`,
      idempotencyKey: `${execution.receipt.admissionKey}:event:${sequence}`,
      executionId: execution.receipt.executionId,
      runId: execution.receipt.runId,
      sequence,
      type: input.type,
      payload: input.payload,
      createdAt: input.createdAt,
    })
    execution.events.push(event)
    execution.state = "running"
    execution.updatedAt = input.createdAt
    return event
  }

  function finish(
    execution: StoredExecution,
    input: {
      status: "succeeded" | "failed" | "cancelled"
      threadId: string | null
      resultSummary: string | null
      usage: AutomationUsage
      error: AutomationError | null
      finishedAt: number
    },
  ): AutomationEngineResult {
    if (execution.result) return execution.result
    const result = automationEngineResultSchema.parse({
      executionId: execution.receipt.executionId,
      runId: execution.receipt.runId,
      status: input.status,
      threadId: input.threadId,
      resultSummary: input.resultSummary,
      usage: input.usage,
      error: input.error,
      finalSequence: execution.events.length,
      finishedAt: input.finishedAt,
    })
    execution.result = result
    execution.state = input.status
    execution.updatedAt = input.finishedAt
    return result
  }

  const adapter: AutomationEngineAdapter = {
    capabilities() {
      return Promise.resolve(automationEngineCapabilityDeclarationSchema.parse(capabilities))
    },

    admit(rawRequest) {
      const request = automationEngineAdmissionRequestSchema.parse(rawRequest)
      const existingId = admissions.get(request.admissionKey)
      if (existingId) {
        const existing = executions.get(existingId)
        if (!existing) throw new Error("Fake Automation engine admission index is corrupt")
        if (
          existing.request.run.id !== request.run.id
          || existing.request.automation.id !== request.automation.id
          || existing.request.revision.id !== request.revision.id
        ) {
          throw new Error("Automation engine admission key was reused for different work")
        }
        return Promise.resolve(automationEngineAdmissionReceiptSchema.parse(existing.receipt))
      }
      const executionId = `${capabilities.adapterId}:execution:${nextExecution}`
      nextExecution += 1
      const receipt = automationEngineAdmissionReceiptSchema.parse({
        receiptVersion: 1,
        adapterId: capabilities.adapterId,
        executionId,
        admissionKey: request.admissionKey,
        runId: request.run.id,
        admittedAt: request.requestedAt,
        attachment: { handle: executionId },
      })
      executions.set(executionId, {
        request,
        receipt,
        events: [],
        state: "admitted",
        result: null,
        updatedAt: request.requestedAt,
      })
      admissions.set(request.admissionKey, executionId)
      return Promise.resolve(receipt)
    },

    observe(rawReceipt, options) {
      const receipt = automationEngineAdmissionReceiptSchema.parse(rawReceipt)
      const execution = stored(receipt)
      const afterSequence = options?.afterSequence ?? 0
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        throw new Error("Automation engine event cursor must be a non-negative integer")
      }
      const events = execution?.events
        .filter((event) => event.sequence > afterSequence) ?? []
      const signal = options?.signal
      return (async function* observeEvents() {
        for (const event of events) {
          if (signal?.aborted) return
          yield automationEngineEventSchema.parse(event)
        }
      })()
    },

    read(rawReceipt) {
      const receipt = automationEngineAdmissionReceiptSchema.parse(rawReceipt)
      const execution = stored(receipt)
      if (!execution) return Promise.resolve(null)
      if (execution.result) {
        return Promise.resolve(automationEngineReadResultSchema.parse(execution.result))
      }
      return Promise.resolve(automationEnginePendingResultSchema.parse({
        status: "pending",
        state: execution.state,
        executionId: execution.receipt.executionId,
        runId: execution.receipt.runId,
        latestSequence: execution.events.length,
        updatedAt: execution.updatedAt,
      }))
    },

    cancel(rawReceipt) {
      const receipt = automationEngineAdmissionReceiptSchema.parse(rawReceipt)
      const requestedAt = now()
      const execution = stored(receipt)
      if (!execution) {
        return Promise.resolve(automationEngineCancellationResultSchema.parse({
          executionId: receipt.executionId,
          runId: receipt.runId,
          outcome: "not_found",
          requestedAt,
        }))
      }
      if (execution.result) {
        return Promise.resolve(automationEngineCancellationResultSchema.parse({
          executionId: receipt.executionId,
          runId: receipt.runId,
          outcome: "already_terminal",
          requestedAt,
        }))
      }
      if (capabilities.cancellation === "unsupported") {
        return Promise.resolve(automationEngineCancellationResultSchema.parse({
          executionId: receipt.executionId,
          runId: receipt.runId,
          outcome: "unsupported",
          requestedAt,
        }))
      }
      appendEvent(execution, {
        type: "terminal",
        payload: { status: "cancelled" },
        createdAt: requestedAt,
      })
      finish(execution, {
        status: "cancelled",
        threadId: null,
        resultSummary: null,
        usage: { inputTokens: null, outputTokens: null, costMicros: null },
        error: {
          code: "cancelled",
          message: "The Automation engine execution was cancelled.",
          retryable: false,
        },
        finishedAt: requestedAt,
      })
      return Promise.resolve(automationEngineCancellationResultSchema.parse({
        executionId: receipt.executionId,
        runId: receipt.runId,
        outcome: "requested",
        requestedAt,
      }))
    },
  }

  return {
    adapter,
    emit(eventInput) {
      const execution = stored(eventInput.receipt)
      if (!execution) throw new Error("Unknown fake Automation engine receipt")
      return appendEvent(execution, eventInput)
    },
    complete(resultInput) {
      const execution = stored(resultInput.receipt)
      if (!execution) throw new Error("Unknown fake Automation engine receipt")
      return finish(execution, resultInput)
    },
  }
}

function conformanceAdmission(input?: {
  admissionKey?: string
  runId?: string
}): AutomationEngineAdmissionRequest {
  const automation = automationSchema.parse({
    id: "automation_engine_conformance",
    organizationId: "organization_engine_conformance",
    ownerMemberId: "member_engine_conformance",
    name: "Engine conformance Automation",
    state: "active",
    currentRevisionId: "revision_engine_conformance",
    nextDueAt: 20_000,
    latestRunAt: null,
    needsAttentionReason: null,
    createdAt: 1_000,
    updatedAt: 1_000,
    archivedAt: null,
  })
  const revision = automationRevisionSchema.parse({
    id: automation.currentRevisionId,
    automationId: automation.id,
    version: 1,
    instructions: "Return the word ready.",
    schedule: { kind: "daily", timezone: "UTC", hour: 9, minute: 0 },
    model: { providerId: "provider_engine_conformance", modelId: "model_engine_conformance" },
    executionTarget: "desktop",
    maximumRuntimeMs: 60_000,
    digest: "0123456789abcdef",
    createdAt: 1_000,
  })
  const run = automationRunSchema.parse({
    id: input?.runId ?? "run_engine_conformance",
    automationId: automation.id,
    revisionId: revision.id,
    trigger: "scheduled",
    scheduledFor: 20_000,
    idempotencyKey: "automation:engine-conformance",
    status: "claimed",
    leaseOwner: "den_conformance",
    leaseExpiresAt: 60_000,
    heartbeatAt: 20_000,
    attemptCount: 1,
    executionTarget: "desktop",
    executionThread: null,
    providerId: revision.model.providerId,
    modelId: revision.model.modelId,
    startedAt: null,
    finishedAt: null,
    error: null,
    resultSummary: null,
    usage: { inputTokens: null, outputTokens: null, costMicros: null },
    createdAt: 20_000,
    updatedAt: 20_000,
  })
  return automationEngineAdmissionRequestSchema.parse({
    admissionKey: input?.admissionKey ?? "admission_engine_conformance",
    automation,
    revision,
    run,
    capabilityAccess: {
      endpoint: `https://den.example.test/mcp/automation-runs/${run.id}`,
      bearerToken: "ephemeral-engine-conformance-token",
      expiresAt: 120_000,
    },
    requestedAt: 20_000,
  })
}

export async function verifyFakeAutomationEngineAdapterConformance(
  harness: FakeAutomationEngineHarness = createFakeAutomationEngineAdapter(),
): Promise<string[]> {
  const checked: string[] = []
  const capabilities = automationEngineCapabilityDeclarationSchema.parse(
    await harness.adapter.capabilities(),
  )
  if (capabilities.reattachment !== "receipt") {
    throw new Error("Automation engine must support receipt reattachment")
  }
  checked.push("capability declaration")

  const request = conformanceAdmission()
  const firstReceipt = automationEngineAdmissionReceiptSchema.parse(
    await harness.adapter.admit(request),
  )
  const duplicateReceipt = automationEngineAdmissionReceiptSchema.parse(
    await harness.adapter.admit(request),
  )
  if (JSON.stringify(firstReceipt) !== JSON.stringify(duplicateReceipt)) {
    throw new Error("Automation engine admission was not idempotent")
  }
  checked.push("idempotent admission")

  harness.emit({
    receipt: firstReceipt,
    type: "assistant",
    payload: { text: "ready" },
    createdAt: 21_000,
  })
  harness.emit({
    receipt: firstReceipt,
    type: "usage",
    payload: { inputTokens: 1, outputTokens: 1 },
    createdAt: 22_000,
  })
  const firstEvents: AutomationEngineEvent[] = []
  const firstValidator = createAutomationEngineEventSequenceValidator(firstReceipt)
  for await (const event of harness.adapter.observe(firstReceipt)) {
    firstValidator.accept(event)
    firstEvents.push(event)
  }
  const replayedEvents: AutomationEngineEvent[] = []
  for await (const event of harness.adapter.observe(firstReceipt)) {
    replayedEvents.push(event)
  }
  if (JSON.stringify(firstEvents) !== JSON.stringify(replayedEvents)) {
    throw new Error("Automation engine replay changed durable event identity")
  }
  const persistedReceipt = automationEngineAdmissionReceiptSchema.parse(
    JSON.parse(JSON.stringify(firstReceipt)),
  )
  const persistedCursor = firstEvents[0]?.sequence ?? 0
  const resumedEvents: AutomationEngineEvent[] = []
  const resumedValidator = createAutomationEngineEventSequenceValidator(
    persistedReceipt,
    persistedCursor,
  )
  for await (const event of harness.adapter.observe(persistedReceipt, {
    afterSequence: persistedCursor,
  })) {
    resumedValidator.accept(event)
    resumedEvents.push(event)
  }
  if (resumedEvents[0]?.sequence !== 2 || resumedValidator.cursor !== 2) {
    throw new Error("Automation engine did not resume from the persisted event cursor")
  }
  checked.push("ordered idempotent events")

  harness.complete({
    receipt: firstReceipt,
    status: "succeeded",
    threadId: "thread_engine_conformance",
    resultSummary: "ready",
    usage: { inputTokens: 1, outputTokens: 1, costMicros: null },
    error: null,
    finishedAt: 23_000,
  })
  const firstRead = await harness.adapter.read(persistedReceipt)
  const secondRead = await harness.adapter.read(persistedReceipt)
  if (
    firstRead?.status !== "succeeded"
    || JSON.stringify(firstRead) !== JSON.stringify(secondRead)
  ) {
    throw new Error("Automation engine terminal result was not durable across reattachment")
  }
  checked.push("restart reattachment")
  checked.push("durable terminal result")

  const cancelReceipt = await harness.adapter.admit(conformanceAdmission({
    admissionKey: "admission_engine_cancellation",
    runId: "run_engine_cancellation",
  }))
  const cancellation = await harness.adapter.cancel(cancelReceipt)
  const cancelledResult = await harness.adapter.read(cancelReceipt)
  if (
    capabilities.cancellation === "unsupported"
      ? cancellation.outcome !== "unsupported"
        || cancelledResult?.status !== "pending"
        || cancelledResult.state !== "admitted"
      : cancellation.outcome !== "requested" || cancelledResult?.status !== "cancelled"
  ) {
    throw new Error("Automation engine did not honor its cancellation declaration")
  }
  checked.push("declared cancellation")
  return checked
}
