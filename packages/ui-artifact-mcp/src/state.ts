import {
  uiArtifactDecisionInputSchema,
  uiArtifactRenderInputSchema,
  type UiArtifactErrorCode,
  type UiArtifactPayload,
  type UiArtifactRenderResult,
  type UiArtifactUseInput,
} from "@openwork/types/ui-artifact"
import { resolveRenderArtifactInput } from "./catalog.js"
import { renderUiArtifact } from "./render.js"

export type UiArtifactUseResolution =
  | { ok: true; result: UiArtifactRenderResult }
  | { ok: false; code: UiArtifactErrorCode; message: string }

export class UiArtifactMockStore {
  readonly #instances = new Map<string, UiArtifactPayload>()
  readonly #clock: () => string

  constructor(options: { clock?: () => string } = {}) {
    this.#clock = options.clock ?? (() => new Date().toISOString())
  }

  use(input: UiArtifactUseInput): UiArtifactUseResolution {
    const decision = uiArtifactDecisionInputSchema.safeParse(input)
    if (decision.success) return this.#decide(decision.data)

    const render = uiArtifactRenderInputSchema.safeParse(input)
    if (!render.success) {
      return {
        ok: false,
        code: "invalid_artifact_payload",
        message: "The UI artifact use input is neither a valid render nor a valid decision.",
      }
    }

    const resolved = resolveRenderArtifactInput(render.data)
    if (!resolved.ok) return resolved
    const current = this.#instances.get(resolved.artifact.instanceId)
    if (current) return { ok: true, result: renderUiArtifact(current) }

    this.#instances.set(resolved.artifact.instanceId, resolved.artifact)
    return { ok: true, result: renderUiArtifact(resolved.artifact) }
  }

  snapshot(instanceId: string): UiArtifactPayload | null {
    return this.#instances.get(instanceId) ?? null
  }

  #decide(input: ReturnType<typeof uiArtifactDecisionInputSchema.parse>): UiArtifactUseResolution {
    const current = this.#instances.get(input.instanceId)
    if (!current || current.artifactId !== "work.approvals") {
      return {
        ok: false,
        code: "state_not_found",
        message: "Render the approval queue before attempting a decision.",
      }
    }
    if (current.revision !== input.expectedRevision) {
      return {
        ok: false,
        code: "revision_conflict",
        message: `The approval queue is now at revision ${current.revision}. Render the current state before deciding.`,
      }
    }

    const selected = current.data.items.find((item) => item.id === input.itemId)
    if (!selected) {
      return {
        ok: false,
        code: "state_not_found",
        message: `No approval item named ${input.itemId} exists in this queue.`,
      }
    }
    if (selected.status !== "pending") {
      return {
        ok: false,
        code: "action_not_allowed",
        message: `${selected.title} is already ${selected.status}.`,
      }
    }

    const revision = current.revision + 1
    const decidedAt = this.#clock()
    const status: "approved" | "rejected" = input.decision === "approve" ? "approved" : "rejected"
    const artifact: UiArtifactPayload = {
      ...current,
      revision,
      operation: "replace",
      source: {
        ...current.source,
        observedAt: decidedAt,
      },
      data: {
        items: current.data.items.map((item) => {
          if (item.id === selected.id) {
            return {
              ...item,
              status,
              decidedAt,
              ...(input.note ? { decisionNote: input.note } : {}),
              actions: undefined,
            }
          }
          if (item.status !== "pending" || !item.actions) return item
          return {
            ...item,
            actions: item.actions.map((action) => ({
              ...action,
              expectedRevision: revision,
            })),
          }
        }),
      },
    }
    this.#instances.set(artifact.instanceId, artifact)

    const result = renderUiArtifact(artifact)
    return {
      ok: true,
      result: {
        ...result,
        interaction: {
          type: "decision",
          itemId: input.itemId,
          decision: input.decision,
          previousRevision: current.revision,
          revision,
        },
      },
    }
  }
}
