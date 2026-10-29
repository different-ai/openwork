/** Applies Den policy through the private host-token route, never renderer credentials. */
export async function applyDesktopEngineForcePolicy(policy, options) {
  // Older Den versions send upgrade:false when their retired rollout is off.
  // Never forward that as a rollback to an older local host.
  if (policy?.upgrade !== true) return
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

/** Legacy positive hints are compatible; false cannot disable default migration. */
export function desktopEngineForcePolicy(response) {
  const policy = response?.enginePolicy
  if (policy?.upgrade !== true) return undefined
  return { upgrade: true }
}
