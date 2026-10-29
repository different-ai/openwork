import { isSandboxError, type SandboxProvider } from "@openwork/sandbox"
import { computerSnapshotSlug } from "./image.js"

/** A Workbot computer's size where the provider takes one per sandbox. */
const COMPUTER_RESOURCES = { cpu: 2, memoryGb: 4, diskGb: 8 }

export type ComputerProviderConfig = {
  kind: "freestyle" | "daytona"
  apiKey: string
  snapshot?: string
  apiUrl?: string
  target?: string
  sandboxClass?: "container" | "linux-vm"
  desktop?: boolean
  keepDays?: number
  /** Never auto-delete a conversation's computer; it stays paused with its memory until removed. */
  persistent?: boolean
  /** Freestyle: the domain the desktop viewer is published under (default style.dev). */
  endpointDomain?: string
}

/**
 * A sandbox gateway in front of several providers (Differently): the runner holds one key for it, and the gateway
 * holds the provider keys and decides by its own policies which provider runs each computer.
 */
export type SandboxGatewayConfig = {
  kind: "differently"
  url: string
  apiKey: string
  /** The gateway's template for the computer image; the gateway maps it to each provider's own image. */
  template: string
}

/**
 * The gateway's adapter loads only when the runner opts into a gateway. Computers ask for Daytona's size, and are
 * idled only as the gateway's pools allow: the adapter reads that as it creates them, never at startup.
 */
export async function createGatewayProvider(config: SandboxGatewayConfig): Promise<SandboxProvider> {
  const { createDifferentlyProvider } = await import("@openwork/sandbox-differently")
  return createDifferentlyProvider({
    url: config.url, apiKey: config.apiKey, template: config.template, platform: { os: "linux", isolation: "unknown" },
    resources: COMPUTER_RESOURCES, discoverLifecycle: true,
  })
}

/** Whether the gateway can create computers right now (infrastructure only, never its policies). */
export async function createGatewayHealth(config: SandboxGatewayConfig): Promise<() => Promise<{ up: boolean; reason: string }>> {
  const { differentlyHealth } = await import("@openwork/sandbox-differently")
  return () => differentlyHealth({ url: config.url, apiKey: config.apiKey })
}

/**
 * A provider or gateway that could not be reached or could not start the computer. Refusals (quotas, placement
 * policy, permissions, unsupported requests) are not: they answer the request and must not be routed around.
 */
export function isInfrastructureError(error: unknown) {
  return isSandboxError(error) && (error.code === "transient" || error.code === "timeout")
}

/** Provider SDKs load only when the runner opts into that provider. */
export async function createComputerProvider(config: ComputerProviderConfig): Promise<SandboxProvider> {
  if (config.kind === "freestyle") {
    const { createFreestyleProvider } = await import("@openwork/sandbox-freestyle")
    if (config.desktop && !config.snapshot) throw new Error("Freestyle desktop computers require HEADLESS_COMPUTER_SNAPSHOT built with snapshot:build:freestyle-desktop")
    return createFreestyleProvider({
      apiKey: config.apiKey, snapshot: config.snapshot ?? computerSnapshotSlug(),
      firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
      // The viewer port is reached through Freestyle's TLS edge; tickets inside the guest still gate every connection.
      ...(config.desktop ? { endpointDomain: config.endpointDomain ?? "style.dev" } : {}),
    })
  }
  if (!config.snapshot) throw new Error("Daytona computers require HEADLESS_COMPUTER_SNAPSHOT built with snapshot:build:daytona")
  if (config.desktop && config.sandboxClass !== "linux-vm") throw new Error("Daytona desktop access requires a Linux VM snapshot")
  const { createDaytonaProvider } = await import("@openwork/sandbox-daytona")
  return createDaytonaProvider({
    apiKey: config.apiKey, apiUrl: config.apiUrl ?? "https://app.daytona.io/api", target: config.target,
    snapshot: config.snapshot, image: "ubuntu:24.04", resources: COMPUTER_RESOURCES,
    helperCreateTimeoutMs: 120_000, pollIntervalMs: 100, platform: { os: "linux", isolation: config.sandboxClass === "linux-vm" ? "microvm" : "container" },
    supportsPause: config.sandboxClass === "linux-vm",
    ...(config.sandboxClass === "linux-vm" && config.keepDays && !config.persistent ? { idleRetentionMinutes: config.keepDays * 1440 } : {}),
  })
}
