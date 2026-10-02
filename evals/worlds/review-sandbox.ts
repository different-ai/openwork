import { createServer } from "node:http";
import { chrome, localHost } from "@openwork/hosts";
import { setViewport } from "@openwork/cdp";
import type { Place, Seed } from "@openwork/env";
import { reviewWorld } from "./evidence-review.ts";

/** Production UI with a local launch-response fixture. No provider calls or VMs. */
export async function reviewSandboxWorld(_seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new Error("Review sandbox UI proof requires local placement.");
  const resources = new AsyncDisposableStack();
  try {
    const review = resources.use(await reviewWorld("preview", true));
    let response: { status: number; body: unknown } = { status: 502, body: { error: "Synthetic launch failure" } };
    const requests: string[] = [];
    const proxy = createServer(async (request, reply) => {
      try {
        if (request.method !== "GET" && request.method !== "HEAD") {
          // Every mutation terminates here; never forward one to the real provider route.
          let body = "";
          for await (const chunk of request) body += chunk.toString();
          requests.push(body);
          reply.writeHead(response.status, { "content-type": "application/json", "cache-control": "no-store" });
          reply.end(JSON.stringify(response.body));
          return;
        }
        const upstream = await fetch(`${review.baseUrl}${request.url}`, { signal: AbortSignal.timeout(10_000) });
        reply.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "text/plain", "cache-control": "no-store" });
        reply.end(Buffer.from(await upstream.arrayBuffer()));
      } catch { reply.writeHead(502); reply.end("Fixture unavailable"); }
    });
    await new Promise<void>((resolve, reject) => {
      proxy.once("error", reject);
      proxy.listen(0, "127.0.0.1", resolve);
    });
    resources.defer(() => new Promise<void>((resolve, reject) => { proxy.closeAllConnections(); proxy.close((error) => error ? reject(error) : resolve()); }));
    const address = proxy.address();
    if (!address || typeof address === "string") throw new Error("Missing fixture address");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const host = resources.use(localHost());
    const app = resources.use(await chrome({ name: "review-sandbox-ui", host, startUrl: "about:blank", headless: true }));
    await setViewport(app, { width: 1440, height: 1000, deviceScaleFactor: 1 });
    return {
      baseUrl, app, passed: review.passed, requests,
      respond(status: number, body: unknown) { response = { status, body }; },
      async [Symbol.asyncDispose]() { await resources.disposeAsync(); },
    };
  } catch (error) { await resources.disposeAsync(); throw error; }
}
