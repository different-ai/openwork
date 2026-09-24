import { evaluate, navigate } from "@openwork/cdp";
import type { CdpClient } from "@openwork/cdp";

/**
 * Chrome occasionally fails the cold dev-server entry graph with no failed
 * response, console error or navigation. Static imports mean no app module has
 * evaluated yet, so one reload is the user's own recovery, not a retry of app
 * behaviour. `describe` is logged so the first failure stays diagnosable.
 */
export function reloadOnceIfEntryFails(input: {
  client: () => CdpClient;
  url: string;
  describe: () => string;
  log?: (line: string) => void;
  pollMs?: number;
}): { reloaded: () => boolean; stop: () => Promise<void> } {
  const log = input.log ?? ((line: string) => console.error(line));
  const stopped = new AbortController();
  let reloaded = false;
  const watching = (async () => {
    while (!stopped.signal.aborted && !reloaded) {
      await new Promise(resolve => setTimeout(resolve, input.pollMs ?? 500));
      if (stopped.signal.aborted) return;
      const failed = await evaluate(input.client(), () => (window.__openworkEvalBootErrors ?? [])
        .some(error => error.endsWith("(/src/index.react.tsx)")), { timeoutMs: 5_000 }).catch(() => false);
      if (failed !== true) continue;
      reloaded = true;
      log(`[openwork/testkit] App-web entry module graph failed before any app code ran; reloading once. ${input.describe()}`);
      await navigate(input.client(), input.url).catch(() => undefined);
    }
  })();
  return {
    reloaded: () => reloaded,
    async stop() {
      stopped.abort();
      await watching;
    },
  };
}
