import type { UIMessage } from "ai";
import {
  AUTO_ROUTER_PROVIDER_ID,
  AUTO_ROUTER_THINKING_LABELS,
  AUTO_ROUTER_THINKING_LEVELS,
  type AutoRouterReplyRoute,
} from "@openwork/types/den/auto-router";
import { AUTO_MODEL_ID, SMART_MODEL_FALLBACK_NAME } from "@/react-app/domains/models/model-catalog";

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" ? Reflect.get(value, key) : undefined;
}
function text(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }

export function replyModelFromInfo(info: unknown) {
  if (field(info, "role") !== "assistant") return undefined;
  const resolved = field(info, "resolvedModel");
  const model = field(info, "model");
  const resolvedModelID = text(field(resolved, "modelID")) ?? text(field(resolved, "id")) ?? text(field(info, "resolvedModelID"));
  const requestedModelID = text(field(info, "modelID")) ?? text(field(model, "id"));
  const requestedProviderID = text(field(info, "providerID")) ?? text(field(model, "providerID"));
  const modelID = resolvedModelID ?? requestedModelID;
  const providerID = text(field(resolved, "providerID")) ?? text(field(info, "resolvedProviderID")) ?? requestedProviderID;
  const name = text(field(resolved, "name"));
  if (!modelID) return undefined;
  return { modelID, ...(providerID ? { providerID } : {}),
    ...(requestedModelID ? { requestedModelID } : {}),
    ...(requestedProviderID ? { requestedProviderID } : {}),
    ...(resolvedModelID ? { resolved: true, ...(name ? { name } : {}) } : {}),
  };
}

export function mergeReplyMetadata(previous: unknown, next: unknown) {
  const record = (value: unknown): object => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const previousModel = field(field(previous, "opencode"), "replyModel");
  const nextModel = field(field(next, "opencode"), "replyModel");
  return { ...record(previous), ...record(next), opencode: {
    ...record(field(previous, "opencode")), ...record(field(next, "opencode")),
    ...(previousModel || nextModel ? { replyModel: field(previousModel, "resolved") === true && field(nextModel, "resolved") !== true
      ? { ...record(nextModel), ...record(previousModel) }
      : { ...record(previousModel), ...record(nextModel) } } : {}),
  } };
}

/** The requested OpenWork Free model keeps OpenWork's mark even after routing upstream; Smart replies show the routed model's maker. */
export function replyModelProvider(message: UIMessage, autoRoutes: readonly AutoRouterReplyRoute[] = []) {
  const route = autoRouteForReply(message, autoRoutes);
  if (route) return route.provider && !/^(ipr|gwm)_/.test(route.provider) ? route.provider : undefined;
  const model = field(field(message.metadata, "opencode"), "replyModel");
  const requestedProviderID = text(field(model, "requestedProviderID"));
  const requestedModelID = text(field(model, "requestedModelID"));
  const providerID = text(field(model, "providerID"));
  if (requestedProviderID === "openwork" || providerID === "openwork"
    || requestedModelID === AUTO_MODEL_ID) return "openwork";
  // Opaque gateway ids must not become a monogram or a remote logo request.
  return providerID?.startsWith("ipr_") ? undefined : providerID;
}

export type ReplyModelTitleResolver = (model: { providerID: string; modelID: string }) => string | undefined;
/** A catalog name for an upstream model id the gateway routed a Smart reply to. */
export type AutoRouteNameResolver = (modelID: string) => string | undefined;

/**
 * The engine may stamp a reply as created when the step began or when its
 * first output arrived, a moment after the gateway's response headers.
 */
const AUTO_ROUTE_SLACK_MS = 2_000;

/**
 * The gateway's routing decision for a Smart reply (feature `autoRouter`).
 * Each Smart step makes one request, so its decision arrives between the
 * reply's start and its completion; the latest one in that window wins, which
 * is the one that answered when a request was retried.
 */
export function autoRouteForReply(message: UIMessage, routes: readonly AutoRouterReplyRoute[]) {
  if (message.role !== "assistant" || routes.length === 0) return undefined;
  const opencode = field(message.metadata, "opencode");
  const model = field(opencode, "replyModel");
  const providerID = text(field(model, "requestedProviderID")) ?? text(field(model, "providerID"));
  if (providerID !== AUTO_ROUTER_PROVIDER_ID) return undefined;
  const created = field(opencode, "created");
  const completed = field(opencode, "completed");
  if (typeof created !== "number") return undefined;
  return routes.findLast(route => route.at >= created - AUTO_ROUTE_SLACK_MS
    && (typeof completed !== "number" || route.at <= completed));
}

function isThinkingLevel(value: string): value is keyof typeof AUTO_ROUTER_THINKING_LABELS {
  return AUTO_ROUTER_THINKING_LEVELS.some(level => level === value);
}

/** "Claude Haiku 5.5 · High": the routed model's name and, unless default, its thinking level. */
export function autoRouteLabel(route: AutoRouterReplyRoute, resolveName?: AutoRouteNameResolver) {
  const bareID = route.model.split("/").at(-1) ?? route.model;
  const name = publicLabel(route.name) ?? publicLabel(resolveName?.(route.model)) ?? publicLabel(bareID);
  if (!name) return null;
  const thinking = isThinkingLevel(route.thinking) && route.thinking !== "default" ? AUTO_ROUTER_THINKING_LABELS[route.thinking] : undefined;
  return thinking ? `${name} · ${thinking}` : name;
}

function publicLabel(value: unknown) {
  const label = text(value);
  return label && !/^(ipr|gwm)_/.test(label) ? label : undefined;
}

/** Prefer verified routing metadata; older engines only report the requested model. */
export function replyModelLabel(
  message: UIMessage,
  resolveTitle?: ReplyModelTitleResolver,
  autoRoutes: readonly AutoRouterReplyRoute[] = [],
  resolveAutoRouteName?: AutoRouteNameResolver,
) {
  const route = autoRouteForReply(message, autoRoutes);
  const routed = route ? autoRouteLabel(route, resolveAutoRouteName) : null;
  if (routed) return routed;
  const model = field(field(message.metadata, "opencode"), "replyModel");
  const modelID = text(field(model, "modelID"));
  if (!modelID) return null;
  const requestedModelID = text(field(model, "requestedModelID")) ?? modelID;
  const providerID = text(field(model, "requestedProviderID")) ?? text(field(model, "providerID"));
  // A Smart Router's replies are named by `autoRoutes` above; without a
  // recorded decision they keep the router's own name ("Smart: Engineering"),
  // never its `openwork-smart-…` id.
  if (providerID === AUTO_ROUTER_PROVIDER_ID) {
    return publicLabel(resolveTitle?.({ providerID, modelID: requestedModelID })) ?? SMART_MODEL_FALLBACK_NAME;
  }
  if (field(model, "resolved") === true) {
    if (modelID === AUTO_MODEL_ID) return "GPT-6 Luna";
    const resolvedLabel = publicLabel(field(model, "name")) ?? publicLabel(modelID);
    if (resolvedLabel) return resolvedLabel;
  }
  // OpenWork Free routes upstream itself: its id is not the model that answered.
  if (!providerID || requestedModelID === AUTO_MODEL_ID) return null;
  return publicLabel(resolveTitle?.({ providerID, modelID: requestedModelID })) ?? null;
}
