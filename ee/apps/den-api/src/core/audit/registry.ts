import type { AuditEventTypeDeclaration, AuditKind, AuditSink } from "./types.js"

export type AuditRegistry = {
  registerSink(sink: AuditSink): void
  sink(): AuditSink
  registerEventTypes(types: readonly AuditEventTypeDeclaration[]): void
  eventTypes(): readonly AuditEventTypeDeclaration[]
  eventTypeFor(kind: AuditKind): AuditEventTypeDeclaration | null
}

const nullSink: AuditSink = async () => null

export function createAuditRegistry(): AuditRegistry {
  let registeredSink: AuditSink | null = null
  const declarations = new Map<AuditKind, AuditEventTypeDeclaration>()
  const actionKinds = new Map<string, AuditKind>()

  return {
    registerSink(sink) {
      if (registeredSink) throw new Error("audit_sink_already_registered")
      registeredSink = sink
    },
    sink: () => registeredSink ?? nullSink,
    registerEventTypes(types) {
      for (const declaration of types) {
        if (declarations.has(declaration.kind)) throw new Error(`audit_event_kind_already_registered:${declaration.kind}`)
        for (const action of declaration.actions) {
          const existing = actionKinds.get(action)
          if (existing) throw new Error(`audit_event_action_already_registered:${action}:${existing}`)
        }
        const frozen: AuditEventTypeDeclaration = Object.freeze({
          ...declaration,
          actions: Object.freeze([...declaration.actions]),
          categories: Object.freeze([...declaration.categories]),
          resources: Object.freeze([...declaration.resources]),
        })
        declarations.set(declaration.kind, frozen)
        for (const action of declaration.actions) actionKinds.set(action, declaration.kind)
      }
    },
    eventTypes: () => [...declarations.values()],
    eventTypeFor: (kind) => declarations.get(kind) ?? null,
  }
}

export const defaultAuditRegistry = createAuditRegistry()

/** Once per process; a second call throws. Until then the sink returns null. */
export function registerAuditSink(sink: AuditSink): void {
  defaultAuditRegistry.registerSink(sink)
}

export function auditSink(): AuditSink {
  return defaultAuditRegistry.sink()
}

export function registerAuditEventTypes(types: readonly AuditEventTypeDeclaration[]): void {
  defaultAuditRegistry.registerEventTypes(types)
}

export function auditEventTypes(): readonly AuditEventTypeDeclaration[] {
  return defaultAuditRegistry.eventTypes()
}

export function auditEventTypeFor(kind: AuditKind): AuditEventTypeDeclaration | null {
  return defaultAuditRegistry.eventTypeFor(kind)
}
