import {
  AUTO_ROUTER_PROVIDER_ID,
  AUTO_ROUTER_RESPONSE_MODEL_HEADER,
  AUTO_ROUTER_RESPONSE_MODEL_NAME_HEADER,
  AUTO_ROUTER_RESPONSE_PROVIDER_HEADER,
  AUTO_ROUTER_RESPONSE_THINKING_HEADER,
  AUTO_ROUTER_SESSION_ROUTES_KEY,
  AUTO_ROUTER_SESSION_ROUTES_MAX,
  autoRouterReplyRoutes,
  type AutoRouterReplyRoute,
} from "@openwork/types/den/auto-router";

type HttpResponse = {
  sessionID: string;
  kind: string;
  model: { providerID: string };
  response: Response;
};

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type AutoRouteContext = {
  session: {
    get(input: { sessionID: string }): Promise<{ metadata?: Record<string, unknown> } | undefined>;
    update(input: { sessionID: string; metadata: Record<string, Json> }): Promise<unknown>;
    hook(
      name: "http.response",
      callback: (event: HttpResponse) => Promise<void>,
      options?: { providerID: string },
    ): Promise<{ dispose: () => Promise<void> }>;
  };
};

function decodeName(value: string | null) {
  if (!value) return undefined;
  try {
    return decodeURIComponent(value).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The gateway's routing decision on an Auto response, or undefined for any other response. */
export function autoRouteFromResponse(response: Response, at: number): AutoRouterReplyRoute | undefined {
  const model = response.headers.get(AUTO_ROUTER_RESPONSE_MODEL_HEADER)?.trim();
  if (!model) return undefined;
  const name = decodeName(response.headers.get(AUTO_ROUTER_RESPONSE_MODEL_NAME_HEADER));
  return {
    at,
    provider: response.headers.get(AUTO_ROUTER_RESPONSE_PROVIDER_HEADER)?.trim() ?? "",
    model,
    ...(name ? { name } : {}),
    thinking: response.headers.get(AUTO_ROUTER_RESPONSE_THINKING_HEADER)?.trim() || "default",
  };
}

function isJson(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return typeof value === "object" && Object.values(value).every(isJson);
}

/** The session's other metadata, kept as is; engine metadata is JSON by schema. */
function jsonRecord(value: unknown): Record<string, Json> {
  const result: Record<string, Json> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, entry] of Object.entries(value)) if (isJson(entry)) result[key] = entry;
  return result;
}

/**
 * Smart Model Router (feature `autoRouter`): the gateway picks the model for
 * each Smart turn and names it in response headers. Record that decision in
 * the session's metadata, which the engine keeps with the session and streams
 * to the app, so the chat can say which model answered each Smart reply.
 *
 * Every Smart Router is a model of the one `openwork-auto` provider, so
 * matching the provider covers all of them. Only that provider's main-loop
 * responses are read; titles, compaction
 * and every other provider are untouched. Recording never blocks or fails the
 * reply.
 */
export default {
  id: "openwork.auto-route",
  setup: async (context: AutoRouteContext) => {
    const queues = new Map<string, Promise<void>>();
    const record = async (sessionID: string, route: AutoRouterReplyRoute) => {
      const session = await context.session.get({ sessionID });
      const metadata = jsonRecord(session?.metadata);
      const routes = [...autoRouterReplyRoutes(metadata[AUTO_ROUTER_SESSION_ROUTES_KEY]), route]
        .slice(-AUTO_ROUTER_SESSION_ROUTES_MAX);
      await context.session.update({
        sessionID,
        metadata: { ...metadata, [AUTO_ROUTER_SESSION_ROUTES_KEY]: routes.map(item => ({ ...item })) },
      });
    };
    const registration = await context.session.hook("http.response", async (event) => {
      if (event.model.providerID !== AUTO_ROUTER_PROVIDER_ID || event.kind !== "primary") return;
      const route = autoRouteFromResponse(event.response, Date.now());
      if (!route) return;
      // One session's writes run in order so a read-modify-write never loses a turn.
      const previous = queues.get(event.sessionID) ?? Promise.resolve();
      const next = previous.then(() => record(event.sessionID, route)).catch(() => undefined);
      queues.set(event.sessionID, next);
      void next.finally(() => { if (queues.get(event.sessionID) === next) queues.delete(event.sessionID); });
    }, { providerID: AUTO_ROUTER_PROVIDER_ID });
    return async () => { await registration.dispose(); };
  },
};
