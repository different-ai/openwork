import { reattachSurface } from "@openwork/cdp";
import { evalIn } from "@openwork/behaviors";
import { resolveEvalEngine, SkipError, type Seed } from "@openwork/env";
import { longHistory } from "./chat.ts";

export async function composerPromptHistory(seed: Seed) {
  if (resolveEvalEngine() !== "v1") throw new SkipError("native v1 stored history (OPENWORK_EVAL_ENGINE=v1)");
  const base = await longHistory(seed);
  return {
    ...base,
    async restart() {
      const previousOrigin = await evalIn(base.app, () => performance.timeOrigin);
      // Real main-process relaunch, keeping the seed-owned profile and engine data.
      await evalIn(base.app, async () => { await window.__OPENWORK_ELECTRON__.shell.relaunch(); })
        .catch(() => undefined); // Quit may destroy the context before the IPC reply; never dispatch twice.
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        try {
          await reattachSurface(base.app, { timeoutMs: 3_000 });
          const origin = await evalIn(base.app, () => performance.timeOrigin, { timeoutMs: 3_000 });
          if (origin !== previousOrigin) return { previousOrigin, origin };
        } catch { /* The old renderer and socket disappear during restart. */ }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("Electron did not relaunch within 90 seconds");
    },
    async [Symbol.asyncDispose]() {
      await base.app.client.send("Browser.close").catch(() => undefined);
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const alive = await fetch(`${base.app.handle.cdpUrl}/json/version`, { signal: AbortSignal.timeout(1_000) })
          .then((response) => response.ok, () => false);
        if (!alive) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error("Relaunched Electron did not close before profile cleanup");
    },
  };
}
