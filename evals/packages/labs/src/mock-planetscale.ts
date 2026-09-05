import { createServer } from "node:http";
import { startEnterpriseTlsReverseEdge } from "./egress.ts";

/** Synthetic PlanetScale wire witness; never forwards queries to a database. */
export async function mockPlanetScale(queryPattern: RegExp) {
  const queries: string[] = [];
  let statuses: number[] = [];
  let matching = queryPattern;
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const payload: unknown = JSON.parse(body);
    if (typeof payload !== "object" || payload === null || !("query" in payload)
      || typeof payload.query !== "string") {
      response.writeHead(400).end();
      return;
    }
    const matched = matching.test(payload.query);
    if (matched) queries.push(payload.query);
    const status = matched ? statuses.shift() ?? 200 : 200;
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(status === 200
      ? { result: { fields: [], rows: [], rowsAffected: "0", insertId: "0" }, timing: 0 }
      : { error: { code: "internal", message: "Synthetic database failure" } }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing mock database port");
  const edge = await startEnterpriseTlsReverseEdge({ upstream: `http://127.0.0.1:${address.port}` });
  return {
    host: new URL(edge.candidateUrl).host,
    caPath: edge.rootPemPath,
    queries,
    respondWith(next: number[], query = queryPattern) {
      matching = query;
      queries.length = 0;
      statuses = [...next];
    },
    async [Symbol.asyncDispose]() {
      await edge.stop();
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    },
  };
}
