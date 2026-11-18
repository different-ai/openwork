/**
 * Where the cloud runner's celld nodes answer their state endpoint (`GET /state` on celld's internal listener), from
 * the environment. Unset, the admin Runner fleet page says it is not configured and Den contacts nothing.
 *
 * - `DEN_HEADLESS_FLEET_STATE_HOST`: a name that resolves to every node, or several separated by commas. On Render
 *   that is the runner service's discovery name (`<service>-discovery`); on Kubernetes a headless service. An entry
 *   may carry its own port (`host:8081`).
 * - `DEN_HEADLESS_FLEET_STATE_PORT`: the internal listener's port (default 8081).
 * - `DEN_HEADLESS_FLEET_NODE_MEMORY_MB`: each node's memory, so the page can show how close a node is to celld's
 *   ceiling. Optional: without it the page shows sizes and celld's own open or closed state, without percentages.
 *
 * The internal listener is celld's operator API and has no authentication, so it must only be reachable on a private
 * network. Den only ever sends `GET /state` to it.
 */
export type RunnerFleetTarget = { host: string; port: number }
export type RunnerFleetConfig = { targets: RunnerFleetTarget[]; nodeMemoryBytes: number | null }

const DEFAULT_PORT = 8081
const MAX_TARGETS = 16
/** A DNS name or an IPv4 address: letters, digits, hyphens and dots only, so a value can never carry a path or user. */
const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/

function port(value: string | undefined, fallback: number): number | null {
  if (value === undefined || value === "") return fallback
  if (!/^\d{1,5}$/.test(value)) return null
  const parsed = Number(value)
  return parsed >= 1 && parsed <= 65_535 ? parsed : null
}

/** Null when the host is unset or any part of the setting is malformed: a half-read setting contacts nothing. */
export function runnerFleetConfig(env: Record<string, string | undefined> = process.env): RunnerFleetConfig | null {
  const hosts = env.DEN_HEADLESS_FLEET_STATE_HOST?.trim()
  if (!hosts) return null
  const defaultPort = port(env.DEN_HEADLESS_FLEET_STATE_PORT?.trim(), DEFAULT_PORT)
  if (defaultPort === null) return null
  const targets: RunnerFleetTarget[] = []
  for (const entry of hosts.split(",").map((value) => value.trim()).filter(Boolean)) {
    const [host, ownPort, ...rest] = entry.split(":")
    const resolved = port(ownPort, defaultPort)
    if (!host || rest.length > 0 || !HOST.test(host) || resolved === null) return null
    targets.push({ host: host.toLowerCase(), port: resolved })
  }
  if (targets.length === 0 || targets.length > MAX_TARGETS) return null
  const megabytes = env.DEN_HEADLESS_FLEET_NODE_MEMORY_MB?.trim()
  const memory = megabytes && /^\d{1,7}$/.test(megabytes) && Number(megabytes) > 0 ? Number(megabytes) * 1024 * 1024 : null
  return { targets, nodeMemoryBytes: memory }
}
