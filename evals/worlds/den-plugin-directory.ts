import type { Seed } from "@openwork/env";
import { isRecord, records } from "./library.ts";

/** A long real directory with one failed cursor request, injected at the network boundary before any test acts. */
export async function denPluginDirectoryWorld(seed: Seed) {
  const den = await seed.den({ org: { name: "Directory studio", admin: { name: "Directory Owner" } } });
  await seed.api(den.admin, "/v1/marketplaces");
  for (let batch = 0; ; batch++) {
    if (batch >= 10) throw new Error("Starter directory did not become empty after ten archive batches");
    const page = await seed.api(den.admin, "/v1/plugins?status=active&limit=100");
    if (!page.response.ok || !isRecord(page.body)) throw new Error("Cannot initialize directory fixture");
    const items = records(page.body.items);
    if (!items.length) break;
    for (const plugin of items) {
      const archived = await seed.api(den.admin, `/v1/plugins/${String(plugin.id)}/archive`, { method: "POST", body: "{}" });
      if (!archived.response.ok) throw new Error("Cannot clear starter directory fixture");
    }
  }
  const names = Array.from({ length: 140 }, (_, index) => `Directory item ${String(index + 1).padStart(3, "0")}`);
  for (const name of names) {
    const created = await seed.api(den.admin, "/v1/plugins", { method: "POST", body: JSON.stringify({ name, description: "A synthetic directory item for scrolling and filtering.", components: [] }) });
    if (!created.response.ok) throw new Error(`Cannot prepare ${name}: ${created.text}`);
  }
  // Start away from the directory, then arm a one-shot cursor fault before the person's first navigation.
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/library", headless: true, viewport: { width: 1440, height: 900 } });
  const endpoint = web.client.webSocketDebuggerUrl;
  if (!endpoint) throw new Error("Directory fixture needs its page CDP endpoint");
  const socket = new WebSocket(endpoint);
  let sequence = 0;
  let rejected = 0;
  let cursorRequests = 0;
  let recovered = false;
  const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  const command = (method: string, params: Record<string, unknown>) => new Promise<void>((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  socket.addEventListener("message", ({ data }) => {
    const message: unknown = JSON.parse(String(data));
    if (!isRecord(message)) return;
    if (typeof message.id === "number") {
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) waiter?.reject(new Error(JSON.stringify(message.error)));
      else waiter?.resolve();
      return;
    }
    if (message.method !== "Fetch.requestPaused" || !isRecord(message.params)) return;
    const { requestId, request } = message.params;
    if (typeof requestId !== "string" || !isRecord(request) || typeof request.url !== "string") return;
    const url = new URL(request.url);
    const cursor = url.pathname.endsWith("/v1/plugins") && request.method === "GET" && Boolean(url.searchParams.get("cursor"));
    if (cursor) cursorRequests++;
    // Fail until the fixture service recovers; the page must stop retrying after its configured retry budget.
    if (cursor && !recovered) {
      rejected++;
      void command("Fetch.fulfillRequest", { requestId, responseCode: 503,
        responseHeaders: [
          { name: "Content-Type", value: "application/json" },
          { name: "Access-Control-Allow-Origin", value: new URL(den.ref.webUrl).origin },
          { name: "Access-Control-Allow-Credentials", value: "true" },
          { name: "Cache-Control", value: "no-store" },
        ], body: Buffer.from(JSON.stringify({ error: "fixture_page_failure", message: "The next directory page is temporarily unavailable." })).toString("base64"),
      });
    } else void command("Fetch.continueRequest", { requestId });
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Directory fault connection timed out")), 15_000);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Directory fault connection failed")); }, { once: true });
  });
  await command("Fetch.enable", { patterns: [{ urlPattern: "*/v1/plugins?*", requestStage: "Request" }] });
  return { web, names, url: (path: string) => new URL(path, den.ref.webUrl).toString(),
    attempts: () => ({ rejected, cursorRequests }),
    recoverNextPage: () => { recovered = true; },
    async [Symbol.asyncDispose]() { socket.close(); },
  };
}
