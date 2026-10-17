import type { SandboxProvider } from "@openwork/sandbox"
import { computerSnapshotSlug } from "./image.js"

export type ComputerProviderConfig = {
  kind: "freestyle" | "daytona"
  apiKey: string
  snapshot?: string
  apiUrl?: string
  target?: string
  sandboxClass?: "container" | "linux-vm"
  desktop?: boolean
  keepDays?: number
}

/** Provider SDKs load only when the runner opts into that provider. */
export async function createComputerProvider(config: ComputerProviderConfig): Promise<SandboxProvider> {
  if (config.kind === "freestyle") {
    const { createFreestyleProvider } = await import("@openwork/sandbox-freestyle")
    return createFreestyleProvider({ apiKey: config.apiKey, snapshot: config.snapshot ?? computerSnapshotSlug(), firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] } })
  }
  if (!config.snapshot) throw new Error("Daytona computers require HEADLESS_COMPUTER_SNAPSHOT built with snapshot:build:daytona")
  if (config.desktop && config.sandboxClass !== "linux-vm") throw new Error("Daytona desktop access requires a Linux VM snapshot")
  const { createDaytonaProvider } = await import("@openwork/sandbox-daytona")
  return createDaytonaProvider({
    apiKey: config.apiKey, apiUrl: config.apiUrl ?? "https://app.daytona.io/api", target: config.target,
    snapshot: config.snapshot, image: "ubuntu:24.04", resources: { cpu: 2, memoryGb: 4, diskGb: 8 },
    helperCreateTimeoutMs: 120_000, pollIntervalMs: 100, platform: { os: "linux", isolation: config.sandboxClass === "linux-vm" ? "microvm" : "container" },
    supportsPause: config.sandboxClass === "linux-vm",
    ...(config.sandboxClass === "linux-vm" && config.keepDays ? { idleRetentionMinutes: config.keepDays * 1440 } : {}),
  })
}
