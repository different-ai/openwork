import { fileURLToPath } from "node:url"
import { createServer } from "vite"
import type { Place, Seed } from "@openwork/env"
import { chrome } from "@openwork/hosts"

/**
 * The production Settings > Computer use page behind the desktop IPC boundary:
 * a Mac with neither permission on and two remembered folders. Buttons on the
 * page stand in for System Settings; no helper or macOS permission is involved.
 */
export async function computerUseSettings(_seed: Seed, { place }: { place: Place }) {
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
    if (!url) throw new Error("The computer use settings fixture did not start")
    const web = resources.use(await chrome({ host: place.host(), name: "computer-use-settings", startUrl: `${url}test-fixtures/computer-use-settings.html?state=setup&grants=some&controls`, headless: true }))
    return { web, async [Symbol.asyncDispose]() { await resources.disposeAsync() } }
  } catch (error) { await resources.disposeAsync(); throw error }
}
