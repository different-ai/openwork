/** Applies Den policy through the private host-token route, never renderer credentials. */
export async function applyDesktopEngineForcePolicy(policy, options) {
  const server = await options.getServerInfo()
  if (!server?.baseUrl || !server?.hostToken) throw new Error("OpenWork engine policy service unavailable")
  const response = await (options.fetchImpl ?? fetch)(`${server.baseUrl.replace(/\/+$/, "")}/experimental/engine-v2-preview/force`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-OpenWork-Host-Token": server.hostToken },
    body: JSON.stringify({ upgrade: policy.upgrade }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`engine_force_policy_failed:${response.status}`)
}

/** Explicit false clears forced upgrade; missing policy leaves bootstrap unchanged. */
export function desktopEngineForcePolicy(response) {
  const policy = response?.enginePolicy
  if (typeof policy?.upgrade !== "boolean") return undefined
  return { upgrade: policy.upgrade }
}
