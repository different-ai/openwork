import { connect, debuggerUrlFor, listTargets } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";
import { browserFastPath } from "./browser-fast-path.ts";

/**
 * Two desktop conversations and a local page the built-in browser can always
 * reach, plus the one fault this world injects: the page's own process stops,
 * as when it runs out of memory, while OpenWork keeps running.
 */
export async function browserDeadTab(seed: Seed, { place }: { place: Place }) {
  const world = await browserFastPath(seed, { place });
  try {
    const other = await seed.session(world.app, { title: "Weekly notes" });
    const cdpUrl = world.app.handle.cdpUrl;
    const pageUrl = `${world.origin}/forms?run=dead-tab`;
    const pageTarget = async () => (await listTargets(cdpUrl)).find((target) => target.type === "page" && target.url === pageUrl);
    /** Whether the page's own process answers a trivial script. */
    const pageResponds = async () => {
      const target = await pageTarget();
      if (!target) return false;
      const client = await connect(debuggerUrlFor(cdpUrl, target), { connectTimeoutMs: 3_000, sendTimeoutMs: 3_000 }).catch(() => null);
      if (!client) return false;
      try {
        const reply = await client.send("Runtime.evaluate", { expression: "1 + 1", returnByValue: true });
        return typeof reply === "object" && reply !== null && "result" in reply
          && typeof reply.result === "object" && reply.result !== null && "value" in reply.result && reply.result.value === 2;
      } catch {
        return false;
      } finally {
        client.close();
      }
    };
    return {
      ...world, other, pageUrl, pageResponds,
      /** Stop the page's own process. OpenWork's main process is untouched. */
      async crashPage() {
        const target = await pageTarget();
        if (!target) throw new Error("The page is not open in the built-in browser.");
        const client = await connect(debuggerUrlFor(cdpUrl, target), { sendTimeoutMs: 3_000 });
        // The page dies before it can answer, so this command never replies.
        await client.send("Page.crash").catch(() => undefined);
        client.close();
      },
      /** Whether OpenWork itself still answers on its debugging port. */
      async appAlive() {
        try {
          return (await fetch(`${cdpUrl}/json/version`, { signal: AbortSignal.timeout(3_000) })).ok;
        } catch {
          return false;
        }
      },
    };
  } catch (error) {
    await world[Symbol.asyncDispose]();
    throw error;
  }
}
