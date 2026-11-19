import { expect, test } from "bun:test";
import { createOpenworkServerClient } from "@/app/lib/openwork-server";

for (const stage of ["fetch", "body"]) {
  test(`JSON request has a single timeout and aborts during ${stage}`, async () => {
    const original = globalThis.fetch;
    let signal: AbortSignal | null | undefined;
    Object.assign(globalThis, { fetch: async (_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal;
      if (stage === "fetch") return new Promise<Response>(() => {});
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } }));
    } });
    try {
      await expect(createOpenworkServerClient({ baseUrl: "http://localhost:1" }).health()).rejects.toThrow("Request timed out.");
      expect(signal?.aborted).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  }, 5_000);
}
