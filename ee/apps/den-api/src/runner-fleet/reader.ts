import { RUNNER_FLEET_NODE_LIMIT, type AdminRunnerFleet, type RunnerFleetNode } from "@openwork/types/den/admin-runner-fleet"
import type { RunnerFleetConfig } from "./config.js"
import { fleetFromNodes, nodeFromState, unreachableNode } from "./state.js"

/**
 * Asks every runner node for its own state, directly: each configured name is resolved to the nodes behind it and
 * each node answers `GET /state` on celld's internal listener. One read is a few small private-network requests, so
 * the page can follow the fleet live; nothing is written and nothing but `/state` is ever requested.
 */
export type RunnerFleetReaderDeps = {
  /** Every IPv4 address behind a name. */
  resolve: (host: string) => Promise<string[]>
  fetch: typeof fetch
  now: () => Date
}

const STATE_TIMEOUT_MS = 2_500
/** A state report lists each cell in memory a few times over; far beyond this it is not a state report. */
const MAX_STATE_CHARS = 16 * 1024 * 1024
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/

type Address = { ip: string; port: number }

async function readNode(address: Address, id: string, limitBytes: number | null, deps: RunnerFleetReaderDeps): Promise<RunnerFleetNode> {
  try {
    const response = await deps.fetch(`http://${address.ip}:${address.port}/state`, {
      headers: { accept: "application/json" },
      // A node never redirects its state; following one would send Den somewhere it was not told to go.
      redirect: "error",
      signal: AbortSignal.timeout(STATE_TIMEOUT_MS),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return unreachableNode(id, `http_${response.status}`, limitBytes)
    }
    if (Number(response.headers.get("content-length") ?? 0) > MAX_STATE_CHARS) {
      await response.body?.cancel().catch(() => undefined)
      return unreachableNode(id, "state_too_large", limitBytes)
    }
    const body = await response.text()
    if (body.length > MAX_STATE_CHARS) return unreachableNode(id, "state_too_large", limitBytes)
    return nodeFromState(id, JSON.parse(body), limitBytes)
  } catch (error) {
    const name = error instanceof Error ? error.name : ""
    return unreachableNode(id, name === "TimeoutError" || name === "AbortError" ? "timeout" : name === "SyntaxError" ? "invalid_state" : "unreachable", limitBytes)
  }
}

export async function readRunnerFleet(config: RunnerFleetConfig, deps: RunnerFleetReaderDeps): Promise<AdminRunnerFleet> {
  const found = new Map<string, Address>()
  let failed = 0
  await Promise.all(config.targets.map(async (target) => {
    try {
      const ips = IPV4.test(target.host) || target.host === "localhost" ? [target.host] : await deps.resolve(target.host)
      for (const ip of ips) if (IPV4.test(ip) || ip === "localhost") found.set(`${ip}:${target.port}`, { ip, port: target.port })
    } catch {
      failed += 1
    }
  }))
  const addresses = [...found.values()].sort((a, b) => a.ip.localeCompare(b.ip) || a.port - b.port).slice(0, RUNNER_FLEET_NODE_LIMIT)
  // A node is known by its address; the port joins the name only where two nodes share an address.
  const shared = new Set(addresses.map((address) => address.ip)).size < addresses.length
  const nodes = await Promise.all(addresses.map((address) => readNode(address, shared ? `${address.ip}:${address.port}` : address.ip, config.nodeMemoryBytes, deps)))
  return fleetFromNodes(nodes, deps.now(), addresses.length === 0 ? (failed > 0 ? "dns_failed" : "no_nodes") : null)
}
