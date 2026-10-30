import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import type { Place, Seed } from "@openwork/env"
import { chrome } from "@openwork/hosts"

/** The production transcript and history controls, with deterministic native tool captures. */
export async function computerSessionHistory(_seed: Seed, { place }: { place: Place }) {
  const resources = new AsyncDisposableStack()
  try {
    const vite = await createServer({
      root: fileURLToPath(new URL("../../apps/app", import.meta.url)),
      configFile: fileURLToPath(new URL("../../apps/app/vite.config.ts", import.meta.url)),
      server: { host: "127.0.0.1", port: 0, strictPort: false },
    })
    resources.defer(() => vite.close())
    await vite.listen()
    const url = vite.resolvedUrls?.local[0]
    if (!url) throw new Error("The history fixture did not start")
    const web = resources.use(await chrome({ host: place.host(), name: "computer-session-history", startUrl: `${url}test-fixtures/computer-session-history.html`, headless: true }))
    return { web, async [Symbol.asyncDispose]() { await resources.disposeAsync() } }
  } catch (error) { await resources.disposeAsync(); throw error }
}
