import { ApiError } from "../errors.js";
import type { ServerObservabilityController } from "../observability.js";
import { addRoute, type RequestContext, type Route } from "./registry.js";

type JsonResponse = (data: unknown, status?: number) => Response;
const MAX_OBSERVABILITY_REQUEST_BYTES = 4 * 1024 * 1024;
const MAX_OBSERVABILITY_DRAIN_BYTES = 8 * 1024 * 1024;

export interface RegisterObservabilityRoutesOptions {
  routes: Route[];
  observability: ServerObservabilityController;
  jsonResponse: JsonResponse;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJson(request: Request): Promise<unknown> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_OBSERVABILITY_REQUEST_BYTES) {
    // Drain modest overages without retaining them so the pooled connection is
    // reusable. Very large declarations are rejected immediately and the
    // server response marks the connection for closure.
    if (request.body && declaredLength <= MAX_OBSERVABILITY_DRAIN_BYTES) {
      const reader = request.body.getReader();
      try {
        while (!(await reader.read()).done) {
          // Deliberately discard bytes above the retention cap.
        }
      } finally {
        reader.releaseLock();
      }
    }
    throw new ApiError(413, "observability_payload_too_large", "Observability payload is too large");
  }
  try {
    if (!request.body) throw new Error("missing body");
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let oversized = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_OBSERVABILITY_REQUEST_BYTES) oversized = true;
        if (total > MAX_OBSERVABILITY_DRAIN_BYTES) break;
        if (!oversized) chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    if (oversized) {
      throw new ApiError(413, "observability_payload_too_large", "Observability payload is too large");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

function optionalInteger(value: string | null, name: string, maximum?: number): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || (maximum !== undefined && parsed > maximum)) {
    throw new ApiError(400, "invalid_query", `${name} must be a non-negative integer${maximum ? ` no greater than ${maximum}` : ""}`);
  }
  return parsed;
}

function requireObservabilityProducerAccess(
  ctx: RequestContext,
  observability: ServerObservabilityController,
): void {
  if (ctx.actor?.scope === "owner") return;
  const internalToken = ctx.request.headers.get("x-openwork-observability-token");
  if (observability.acceptsInternalToken(internalToken)) return;
  throw new ApiError(403, "observability_forbidden", "Owner access is required for observability");
}

function requireObservabilityOwner(ctx: RequestContext): void {
  if (ctx.actor?.scope === "owner") return;
  throw new ApiError(403, "observability_forbidden", "Owner access is required for observability");
}

function noStore(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store, max-age=0");
  headers.set("Pragma", "no-cache");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function registerObservabilityRoutes(options: RegisterObservabilityRoutesOptions): void {
  const { routes, observability, jsonResponse } = options;

  addRoute(routes, "GET", "/observability/config", "client", async (ctx) => {
    requireObservabilityProducerAccess(ctx, observability);
    return noStore(jsonResponse({
      config: observability.getConfig(),
      collectionEpoch: observability.getCollectionEpoch(),
    }));
  });

  addRoute(routes, "PUT", "/observability/config", "client", async (ctx) => {
    requireObservabilityOwner(ctx);
    const body = await readJson(ctx.request);
    if (!isRecord(body)) {
      throw new ApiError(400, "invalid_observability_config", "Observability config must be an object");
    }
    return noStore(jsonResponse({ config: observability.configure(body) }));
  });

  addRoute(routes, "GET", "/observability/events", "client", async (ctx) => {
    requireObservabilityOwner(ctx);
    observability.heartbeat();
    const after = optionalInteger(ctx.url.searchParams.get("after"), "after");
    const limit = optionalInteger(ctx.url.searchParams.get("limit"), "limit", 1_000);
    const stats = observability.stats();
    return noStore(jsonResponse({
      config: observability.getConfig(),
      collectionEpoch: observability.getCollectionEpoch(),
      events: observability.list({ after, limit }),
      lastSequence: stats.lastSequence,
      droppedCount: stats.droppedCount,
      retainedBytes: stats.retainedBytes,
      maxBytes: stats.maxBytes,
    }));
  });

  addRoute(routes, "POST", "/observability/events", "client", async (ctx) => {
    requireObservabilityProducerAccess(ctx, observability);
    const body = await readJson(ctx.request);
    const candidates = Array.isArray(body)
      ? body
      : isRecord(body) && Array.isArray(body.events)
        ? body.events
        : [body];
    if (candidates.length > 250) {
      throw new ApiError(413, "too_many_observability_events", "At most 250 observability events can be ingested at once");
    }
    let accepted = 0;
    let rejected = 0;
    for (const candidate of candidates) {
      if (observability.recordUnknown(candidate)) accepted += 1;
      else rejected += 1;
    }
    return noStore(jsonResponse({ ok: true, accepted, rejected }));
  });

  addRoute(routes, "DELETE", "/observability/events", "client", async (ctx) => {
    requireObservabilityOwner(ctx);
    observability.clear();
    return noStore(jsonResponse({ ok: true }));
  });
}
