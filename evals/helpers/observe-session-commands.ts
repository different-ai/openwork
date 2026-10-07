import { browserScript } from "@openwork/cdp";
import type { Probe } from "@openwork/testkit";

/** Observe command admission without collecting prompts, credentials or payloads. */
export async function observeSessionCommands(probe: Probe) {
  const key: `command-observer-${string}` = `command-observer-${crypto.randomUUID()}`;
  await probe.eval(browserScript((key: `command-observer-${string}`) => {
    const requests: { method: string; path: string }[] = [];
    const original = window.fetch;
    const wrapped: typeof fetch = (...args) => {
      const input = args[0];
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = args[1]?.method ?? (input instanceof Request ? input.method : "GET");
      if (method !== "GET" && /\/session\/[^/]+\/(?:prompt|prompt_async|abort|interrupt)$/.test(url.pathname)) requests.push({ method, path: url.pathname });
      return original.apply(window, args);
    };
    window.fetch = wrapped;
    window[key] = { requests, stop() { if (window.fetch === wrapped) window.fetch = original; } };
  }, [key]));
  return {
    read() { return probe.eval(browserScript((key: `command-observer-${string}`) => window[key]?.requests ?? [], [key])); },
    async [Symbol.asyncDispose]() { await probe.eval(browserScript((key: `command-observer-${string}`) => { window[key]?.stop(); delete window[key]; }, [key])); },
  };
}
