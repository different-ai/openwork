import type { ConnectionInfo, CredentialValue, Json, ModelInfo, NativeMessage, NativePluginContext, NativeSessionInfo } from "./opencode.ts"
import { isRecord } from "./den.ts"

/** Mirror native 2.0.26's LocationQuery decoder, not a permissive mock. */
function modelLocationQuery(input: unknown): void {
  if (input === undefined) return
  if (!isRecord(input) || (input.location !== undefined && (!isRecord(input.location)
    || (input.location.directory !== undefined && typeof input.location.directory !== "string")))) {
    throw new Error("Invalid native LocationQuery")
  }
}

export function testModel(): ModelInfo {
  return { id: "local-model", modelID: "upstream-model", providerID: "local-provider", name: "Local model", enabled: true,
    capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [{ id: "careful" }], time: { released: 0 },
    cost: [], status: "active", limit: { context: 100_000, output: 10_000 } }
}

export function createNativeHost(directory = process.cwd()) {
  const storage = new Map<string, Json>()
  const calls: Array<{ method: string; input: unknown }> = []
  const sessions = new Map<string, NativeSessionInfo>()
  const histories = new Map<string, NativeMessage[]>()
  const admissions = new Map<string, Set<string>>()
  let sequence = 0
  let time = 1000
  let connection: ConnectionInfo | undefined = { type: "credential", id: "cred_one", label: "Example", method: "oauth" }
  let credential: CredentialValue | undefined = { type: "oauth", methodID: "code", access: "member-one", refresh: "member-one", expires: 100_000_000,
    metadata: { apiBaseUrl: "https://den.example.test", orgId: "org_example" } }
  let resolveError: Error | null = null
  let blockedResolve: (() => Promise<CredentialValue | undefined>) | null = null
  let pendingPermissions = false
  const info = (id: string) => {
    const value = sessions.get(id)
    if (!value) throw new Error("Native session missing")
    return value
  }
  const ctx: NativePluginContext = {
    app: { version: "2.0.26" }, location: { directory }, options: {},
    integration: { transform: async () => ({ dispose: async () => {} }), get: async () => ({}),
      connection: { active: async () => connection, resolve: async () => { if (resolveError) throw resolveError; return blockedResolve ? blockedResolve() : credential }, status: async () => {} } },
    provider: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
    mcp: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
    storage: { get: async key => storage.get(key), set: async (key, value) => { calls.push({ method: "storage.set", input: key }); storage.set(key, value) },
      remove: async key => { storage.delete(key) } },
    session: {
      create: async input => {
        calls.push({ method: "session.create", input })
        const existing = input.id ? sessions.get(input.id) : undefined
        if (existing) return existing
        const value: NativeSessionInfo = { id: input.id ?? `ses_example${++sequence}`, title: input.title, location: input.location,
          ...(input.metadata ? { metadata: input.metadata } : {}),
          ...(input.model ? { model: input.model } : {}), time: { created: ++time, updated: time } }
        sessions.set(value.id, value); histories.set(value.id, []); admissions.set(value.id, new Set())
        return value
      },
      get: async input => { calls.push({ method: "session.get", input }); return info(input.sessionID) },
      context: async input => { calls.push({ method: "session.context", input }); return histories.get(input.sessionID) ?? [] },
      switchModel: async input => { calls.push({ method: "session.switchModel", input }); sessions.set(input.sessionID, { ...info(input.sessionID), model: input.model }) },
      prompt: async input => {
        calls.push({ method: "session.prompt", input })
        if (!admissions.get(input.sessionID)?.has(input.id)) {
          admissions.get(input.sessionID)?.add(input.id)
          histories.get(input.sessionID)?.push({ id: input.id, type: "user", text: input.text, time: { created: ++time } })
        }
        return { id: input.id, sessionID: input.sessionID }
      },
      interrupt: async input => { calls.push({ method: "session.interrupt", input }); return { interrupted: true } },
    },
    model: {
      list: async input => { modelLocationQuery(input); calls.push({ method: "model.list", input }); return { location: { directory }, data: [testModel()] } },
      default: async input => { modelLocationQuery(input); calls.push({ method: "model.default", input }); return { location: { directory }, data: testModel() } },
    },
    permission: { list: async input => pendingPermissions ? [{ id: "perm_example", sessionID: input.sessionID }] : [] },
  }
  return {
    ctx, calls, storage, histories, sessions,
    set connection(value: ConnectionInfo | undefined) { connection = value },
    set credential(value: CredentialValue | undefined) { credential = value },
    get credential() { return credential },
    set resolveError(value: Error | null) { resolveError = value },
    set blockedResolve(value: (() => Promise<CredentialValue | undefined>) | null) { blockedResolve = value },
    set pendingPermissions(value: boolean) { pendingPermissions = value },
    finish(id: string, text = "Current answer") {
      histories.get(id)?.push({ id: `msg_answer${++sequence}`, type: "assistant", model: { providerID: "local-provider", id: "local-model" },
        content: [{ type: "text", text }], time: { created: ++time, completed: time } })
      histories.get(id)?.push({ id: `msg_idle${++sequence}`, type: "idle", outcome: "succeeded", time: { created: ++time } })
      const value = info(id)
      sessions.set(id, { ...value, outcome: "succeeded", time: { ...value.time, idle: time, updated: time } })
    },
  }
}
