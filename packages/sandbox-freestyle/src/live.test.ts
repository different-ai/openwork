import { test } from "node:test"
import { sandboxBlockConformanceCases } from "@openwork/sandbox/testing"
import { createFreestyleProvider } from "./index.js"
const key = process.env.FREESTYLE_API_KEY
if (!key) throw new Error("test:live requires FREESTYLE_API_KEY (creates and deletes real VMs)")
for (const c of sandboxBlockConformanceCases(() => createFreestyleProvider({
  apiKey: key, snapshot: process.env.SANDBOX_TEST_SNAPSHOT ?? "freestyle/ubuntu-sm",
  firewall: { rules: [] },
}), ["run", "files", "pause", "snapshots"])) test(`Freestyle: ${c.name}`, { timeout: 120000 }, c.run)
