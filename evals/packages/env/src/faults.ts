import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import { allocateFreePort } from "@openwork/cdp";
import { startFaultProxyOnSandbox } from "@openwork/hosts";
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders, Server, ServerResponse } from "node:http";
import type { DenRef } from "@openwork/behaviors";
import type { Place } from "./place.ts";

export interface FaultRequest {
  method: string;
  path: string;
  status: number;
  faulted: boolean;
  at: number;
}

export interface FaultProxy extends AsyncDisposable {
  ref: DenRef;
  faults: {
    status(pathPrefix: string, statusCode: number, opts?: { times?: number; body?: unknown }): Promise<void>;
    latency(pathPrefix: string, delayMs: number, opts?: { times?: number }): Promise<void>;
    clear(): Promise<void>;
  };
  /** Local lane: the live in-memory log (back-compat). Remote lane: the snapshot from the last requestLog() call. */
  requests: FaultRequest[];
  /** Authoritative log in both lanes: local returns a copy; remote fetches from the control plane and refreshes `requests`. */
  requestLog(): Promise<FaultRequest[]>;
}

export interface FaultProxyOptions {
  place?: Place;
  sandbox?: string;
}

interface RuleBase {
  pathPrefix: string;
  remaining: number;
}

type FaultRule =
  | (RuleBase & { kind: "status"; statusCode: number; body: unknown })
  | (RuleBase & { kind: "latency"; delayMs: number });

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(",") : value ?? "";
}

function forwardedHeaders(source: IncomingHttpHeaders, host?: string): OutgoingHttpHeaders {
  const nominated = new Set(headerText(source.connection).split(",").map((name) => name.trim().toLowerCase()).filter(Boolean));
  const headers: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name) || nominated.has(name)) continue;
    headers[name] = value;
  }
  if (host) headers.host = host;
  return headers;
}

function times(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 0) throw new Error(`Fault times must be a non-negative integer, got ${value}.`);
  return value;
}

function takeRule(rules: FaultRule[], path: string): FaultRule | null {
  for (const rule of rules) {
    if (rule.remaining <= 0 || !path.startsWith(rule.pathPrefix)) continue;
    rule.remaining -= 1;
    return rule;
  }
  return null;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

function writeUpstreamResponse(client: ServerResponse, status: number, message: string | undefined, headers: OutgoingHttpHeaders): void {
  if (message) client.writeHead(status, message, headers);
  else client.writeHead(status, headers);
}

function forward(
  incoming: IncomingMessage,
  client: ServerResponse,
  upstream: URL,
  faulted: boolean,
  requests: FaultRequest[],
): void {
  const path = incoming.url ?? "/";
  const onResponse = (response: IncomingMessage): void => {
    const status = response.statusCode ?? 502;
    requests.push({ method: incoming.method ?? "GET", path, status, faulted, at: Date.now() });
    writeUpstreamResponse(client, status, response.statusMessage, forwardedHeaders(response.headers));
    response.pipe(client);
  };
  // Pin the upstream origin and take only the path from the caller. An
  // absolute-form request target (legal for proxy requests) would otherwise
  // steer this fetch at an arbitrary host, because `new URL(absolute, base)`
  // discards the base.
  const requested = new URL(path, "http://request-target.invalid");
  const options = {
    protocol: upstream.protocol,
    hostname: upstream.hostname,
    port: upstream.port,
    path: `${requested.pathname}${requested.search}`,
    method: incoming.method ?? "GET",
    headers: forwardedHeaders(incoming.headers, upstream.host),
  };
  const outbound = upstream.protocol === "https:"
    ? httpsRequest(options, onResponse)
    : httpRequest(options, onResponse);
  outbound.on("error", (error) => {
    if (client.headersSent) {
      client.destroy(error);
      return;
    }
    requests.push({ method: incoming.method ?? "GET", path, status: 502, faulted, at: Date.now() });
    client.writeHead(502, { "content-type": "application/json" });
    client.end(JSON.stringify({ error: error.message }));
  });
  incoming.on("aborted", () => outbound.destroy());
  incoming.pipe(outbound);
}

async function localFaultProxy(ref: DenRef): Promise<FaultProxy> {
  const upstream = new URL(ref.webUrl);
  const port = await allocateFreePort();
  const rules: FaultRule[] = [];
  const requests: FaultRequest[] = [];
  const server = createServer((incoming, response) => {
    void (async () => {
      const path = incoming.url ?? "/";
      const rule = takeRule(rules, path);
      if (rule?.kind === "status") {
        const body = JSON.stringify(rule.body ?? { error: `Injected HTTP ${rule.statusCode}` });
        requests.push({ method: incoming.method ?? "GET", path, status: rule.statusCode, faulted: true, at: Date.now() });
        response.writeHead(rule.statusCode, {
          "access-control-allow-origin": "*",
          "content-length": Buffer.byteLength(body),
          "content-type": "application/json",
        });
        response.end(body);
        return;
      }
      if (rule?.kind === "latency") await delay(rule.delayMs);
      forward(incoming, response, upstream, rule !== null, requests);
    })().catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
        return;
      }
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${port}`;
  let disposed = false;
  return {
    ref: { apiUrl: `${url}/api/den`, webUrl: url },
    faults: {
      async status(pathPrefix, statusCode, opts = {}) {
        rules.push({ kind: "status", pathPrefix, statusCode, body: opts.body, remaining: times(opts.times) });
      },
      async latency(pathPrefix, delayMs, opts = {}) {
        rules.push({ kind: "latency", pathPrefix, delayMs, remaining: times(opts.times) });
      },
      async clear() {
        rules.length = 0;
      },
    },
    requests,
    async requestLog(): Promise<FaultRequest[]> {
      return [...requests];
    },
    async [Symbol.asyncDispose](): Promise<void> {
      if (disposed) return;
      disposed = true;
      await closeServer(server);
    },
  };
}

function isFaultRequest(value: unknown): value is FaultRequest {
  if (typeof value !== "object" || value === null) return false;
  return "method" in value && typeof value.method === "string"
    && "path" in value && typeof value.path === "string"
    && "status" in value && typeof value.status === "number"
    && "faulted" in value && typeof value.faulted === "boolean"
    && "at" in value && typeof value.at === "number";
}

export async function faultProxy(ref: DenRef, options: FaultProxyOptions = {}): Promise<FaultProxy> {
  if (options.place?.kind !== "daytona") return localFaultProxy(ref);
  if (!options.sandbox) {
    throw new Error("fault proxy on Daytona needs the Den sandbox id; pass `sandbox: den.placement.sandboxId`.");
  }

  const remote = await startFaultProxyOnSandbox({ sandbox: options.sandbox });
  const requests: FaultRequest[] = [];
  const control = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const response = await fetch(`${remote.url}/__openwork_faults/${path}`, {
      ...init,
      headers: { ...init.headers, "x-openwork-fault-token": remote.token },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Fault proxy control ${path} failed: HTTP ${response.status}${body ? ` ${body}` : ""}`);
    }
    return response;
  };
  const post = async (path: string, body?: unknown): Promise<void> => {
    await control(path, {
      method: "POST",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };
  let disposed = false;
  return {
    ref: { apiUrl: `${remote.url}/api/den`, webUrl: remote.url },
    faults: {
      status(pathPrefix, statusCode, opts = {}) {
        return post("rules", { kind: "status", pathPrefix, statusCode, times: opts.times, body: opts.body });
      },
      latency(pathPrefix, delayMs, opts = {}) {
        return post("rules", { kind: "latency", pathPrefix, delayMs, times: opts.times });
      },
      clear() {
        return post("clear");
      },
    },
    requests,
    async requestLog(): Promise<FaultRequest[]> {
      const response = await control("requests");
      const body: unknown = await response.json();
      if (typeof body !== "object" || body === null || !("requests" in body) || !Array.isArray(body.requests) || !body.requests.every(isFaultRequest)) {
        throw new Error("Fault proxy control requests returned an invalid response.");
      }
      requests.splice(0, requests.length, ...body.requests);
      return [...requests];
    },
    async [Symbol.asyncDispose](): Promise<void> {
      if (disposed) return;
      disposed = true;
      await remote.stop().catch((error: unknown) => {
        console.error(`[openwork/testkit] Fault proxy cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    },
  };
}
