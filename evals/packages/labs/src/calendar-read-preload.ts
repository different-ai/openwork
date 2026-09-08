// Provider witness loaded only by the desktop Calendar boundary spec.
// No real provider request may escape this process.
import { createServer } from "node:http";

const requests: Array<Record<string, string>> = [];
const witness = createServer((_request, response) => {
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(requests));
});
witness.listen(0, "127.0.0.1", () => {
  const address = witness.address();
  if (address && typeof address !== "string") console.log(`Calendar witness: http://127.0.0.1:${address.port}`);
});
witness.unref();

const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return originalFetch(input, init);
  if (url.origin !== "https://www.googleapis.com" || url.pathname !== "/calendar/v3/calendars/primary/events") {
    throw new Error("Unexpected external request in Calendar witness");
  }
  if ((init?.method ?? "GET") !== "GET" || new Headers(init?.headers).get("authorization") !== "Bearer calendar-fixture-token") {
    throw new Error("Calendar witness requires a read with the synthetic account token");
  }
  const query = Object.fromEntries(url.searchParams);
  requests.push(query);
  if (!/^\d+$/.test(query.maxResults) || !Number.isFinite(Date.parse(query.timeMin)) || !Number.isFinite(Date.parse(query.timeMax)) || Date.parse(query.timeMax) <= Date.parse(query.timeMin)) {
    return Response.json({ error: { message: "Bad Request" } }, { status: 400 });
  }
  if (query.maxResults === "13") return Response.json({ error: { message: "Synthetic provider rejection" } }, { status: 400 });
  return Response.json({ items: [{ id: "synthetic-event", summary: "Fixture meeting" }] });
}, originalFetch);
