import { RuntimeProviderError, type SandboxSnapshots } from "@openwork/sandbox"

/** Same hot-snapshot REST contract used by Daytona evidence worlds; no build or warm pool. */
export function memorySnapshots(config: { apiKey: string; apiUrl: string }, sandboxId: (ref: Parameters<SandboxSnapshots["create"]>[0]["ref"]) => string, request: typeof fetch = fetch): SandboxSnapshots {
  let end = config.apiUrl.length
  while (end > 0 && config.apiUrl[end - 1] === "/") end--
  const url = config.apiUrl.slice(0, end)
  const error = (code: "invalid_state" | "conflict" | "timeout" | "unknown", message: string) => new RuntimeProviderError({ providerId: "daytona", code, retryable: false, message })
  async function call(method: string, path: string, deadline: number, body?: unknown) {
    if (Date.now() >= deadline) throw error("timeout", "Daytona snapshot deadline exceeded; inspect its state before retrying")
    let response: Response
    try {
      response = await request(`${url}${path}`, { method, headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) })
    } catch { throw error("unknown", "Daytona snapshot outcome is unknown; inspect the named snapshot before retrying") }
    if (response.status === 404 && method !== "POST") { await response.body?.cancel(); return null }
    if (!response.ok) { await response.body?.cancel(); throw error(response.status === 409 ? "conflict" : "unknown", `Daytona snapshot request failed (HTTP ${response.status})`) }
    if (method !== "GET") { await response.body?.cancel(); return {} }
    return response.json()
  }
  return {
    async create(handle, name, opts) {
      if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name) || handle.state !== "running") throw error("invalid_state", "Hot snapshots require a running microVM and a lowercase snapshot name")
      const deadline = Date.now() + opts.timeoutMs
      const path = `/snapshots/${encodeURIComponent(name)}`
      if (await call("GET", path, deadline)) throw error("conflict", "The named snapshot already exists; choose a new name")
      await call("POST", `/sandbox/${encodeURIComponent(sandboxId(handle.ref))}/snapshot`, deadline, { name, includeMemory: true })
      for (;;) {
        const snapshot = await call("GET", path, deadline)
        if (typeof snapshot === "object" && snapshot !== null && "state" in snapshot) {
          if (snapshot.state === "active" && "id" in snapshot && typeof snapshot.id === "string") return { id: snapshot.id, version: name }
          if (typeof snapshot.state === "string" && /error|fail/.test(snapshot.state)) throw error("invalid_state", "Daytona could not prepare the hot snapshot")
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(1, deadline - Date.now()))))
      }
    },
    async destroy(image, opts) {
      const deadline = Date.now() + opts.timeoutMs
      const snapshot = await call("GET", `/snapshots/${encodeURIComponent(image.id)}`, deadline)
      if (!snapshot) return
      if (typeof snapshot !== "object" || !("id" in snapshot) || typeof snapshot.id !== "string") throw error("invalid_state", "Daytona did not identify the snapshot to delete")
      await call("DELETE", `/snapshots/${encodeURIComponent(snapshot.id)}`, deadline)
    },
  }
}
