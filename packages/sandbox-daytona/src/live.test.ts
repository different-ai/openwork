import { test } from "node:test"
import { sandboxBlockConformanceCases } from "@openwork/sandbox/testing"
import { createDaytonaProvider } from "./index"
const key = process.env.DAYTONA_API_KEY
if (!key) throw new Error("test:live requires DAYTONA_API_KEY (creates and deletes real sandboxes)")
for (const c of sandboxBlockConformanceCases(() => createDaytonaProvider({
  apiKey: key, apiUrl: process.env.DAYTONA_API_URL ?? "https://app.daytona.io/api",
  snapshot: process.env.SANDBOX_TEST_SNAPSHOT ?? "openwork-0.18.55", image: "node:20-bookworm",
  resources: { cpu: 1, memoryGb: 1, diskGb: 4 }, pollIntervalMs: 100, helperCreateTimeoutMs: 60000,
  platform: { os: "linux", isolation: "container" },
}), ["run", "files"])) test(`Daytona: ${c.name}`, { timeout: 120000 }, c.run)
