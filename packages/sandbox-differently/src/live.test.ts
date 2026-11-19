import { test } from "node:test"
import { sandboxBlockConformanceCases, sandboxProviderConformanceCases } from "@openwork/sandbox/testing"
import { createDifferentlyProvider } from "./index.js"

// Opt-in: allocates real sandboxes on a Differently installation and deletes them in finally.
// DIFFERENTLY_URL=… DIFFERENTLY_API_KEY=… [DIFFERENTLY_TEMPLATE=…] [DIFFERENTLY_ENDPOINTS=false] pnpm test:live
const url = process.env.DIFFERENTLY_URL
const apiKey = process.env.DIFFERENTLY_API_KEY
const factory = () => createDifferentlyProvider({
  url: url ?? "", apiKey: apiKey ?? "", template: process.env.DIFFERENTLY_TEMPLATE || null,
  endpoints: process.env.DIFFERENTLY_ENDPOINTS !== "false",
})
const skip = !url || !apiKey ? "set DIFFERENTLY_URL and DIFFERENTLY_API_KEY" : false
for (const c of sandboxProviderConformanceCases(factory, { timeoutMs: 120_000 })) test(`live: ${c.name}`, { skip }, c.run)
for (const c of sandboxBlockConformanceCases(factory, ["run", "files", "pause", "snapshots"])) test(`live: ${c.name}`, { skip }, c.run)
