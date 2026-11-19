import { z } from "zod";
import {
  INFERENCE_WINDOW_TYPES,
  OPENWORK_MODELS_ALLOWANCE_ERROR_CODE,
  OPENWORK_MODELS_ALLOWANCE_MESSAGE,
  OPENWORK_MODELS_ALLOWANCE_SOURCE,
  isInferenceWindowType,
  type InferenceWindowType,
} from "@openwork/types/den/inference";

/**
 * The organization used its OpenWork Models allowance (the gateway's classified 429). Stored on the transcript's
 * error message, so the reset time is absolute. No organization identifiers: they never reach the UI.
 */
export const openWorkModelsLimitSchema = z.object({
  windowType: z.enum(INFERENCE_WINDOW_TYPES).nullable(),
  resetAt: z.iso.datetime().nullable(),
});
export type OpenWorkModelsLimit = z.infer<typeof openWorkModelsLimitSchema>;

function field(value: unknown, key: string): unknown {
  return value && typeof value === "object" && key in value ? Reflect.get(value, key) : undefined;
}

function header(headers: unknown, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof value === "string") return value;
  }
  return null;
}

/** The gateway's own body: `{ error: { code: "openwork_models_allowance_reached", source: "openwork_models" } }`. */
function allowanceBody(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 16_384) return false;
  const start = value.indexOf("{");
  if (start < 0) return false;
  try {
    const parsed: unknown = JSON.parse(value.slice(start));
    const error = field(parsed, "error");
    return field(error, "code") === OPENWORK_MODELS_ALLOWANCE_ERROR_CODE && field(error, "source") === OPENWORK_MODELS_ALLOWANCE_SOURCE;
  } catch {
    return false;
  }
}

/**
 * Reads the classified allowance error from whatever shape the engine reports (v1 APIError with headers and body,
 * v2 text naming HTTP 429 with the body, or v2's bare gateway message). Anything else, including an ordinary 429, is
 * not this limit.
 */
export function parseOpenWorkModelsLimitError(value: unknown, now = Date.now()): OpenWorkModelsLimit | null {
  const records = [value, field(value, "data"), field(value, "cause"), field(field(value, "cause"), "data")];
  const statuses = records.flatMap((record) => [field(record, "statusCode"), field(record, "status")]).filter((status) => typeof status === "number");
  if (statuses.some((status) => status !== 429)) return null;
  for (const record of records) {
    const headers = field(record, "responseHeaders");
    const marked = header(headers, "x-openwork-error-code") === OPENWORK_MODELS_ALLOWANCE_ERROR_CODE
      && header(headers, "x-openwork-usage-state") === "blocked";
    const body = allowanceBody(field(record, "responseBody")) || allowanceBody(field(record, "message"));
    const http429 = statuses.includes(429) || /\bHTTP 429\b/.test(String(field(record, "message") ?? ""));
    // Engine v2 reports the gateway's exact message without the response; it is the gateway's own constant.
    const gatewayMessage = field(record, "message") === OPENWORK_MODELS_ALLOWANCE_MESSAGE;
    if (!(http429 && (marked || body)) && !gatewayMessage) continue;
    const windowType = header(headers, "x-openwork-limit-window-type");
    const resetHeader = header(headers, "x-openwork-limit-reset-at");
    const retryAfter = Number(header(headers, "retry-after") ?? NaN);
    const resetAt = resetHeader && Number.isFinite(Date.parse(resetHeader)) ? new Date(Date.parse(resetHeader)).toISOString()
      : Number.isFinite(retryAfter) && retryAfter > 0 ? new Date(now + retryAfter * 1000).toISOString() : null;
    return { windowType: isInferenceWindowType(windowType) ? windowType : null, resetAt };
  }
  return null;
}

/** "in 3 hours", "in 20 minutes", "on Monday": when a limit ends. Null once it has passed or when unknown. */
export function usageLimitResetPhrase(resetAt: string | null | undefined, now = Date.now()): string | null {
  const at = resetAt ? Date.parse(resetAt) : NaN;
  if (!Number.isFinite(at) || at <= now) return null;
  const minutes = Math.ceil((at - now) / 60_000);
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `in ${hours} hour${hours === 1 ? "" : "s"}`;
  return `on ${new Date(at).toLocaleDateString(undefined, { weekday: "long" })}`;
}

const windowNames: Record<InferenceWindowType, string> = {
  five_hour: "5-hour allowance", weekly: "Weekly allowance", monthly: "Monthly allowance",
};

export function openWorkModelsLimitCopy(limit: OpenWorkModelsLimit, workspaceName: string | null, now = Date.now()) {
  const back = usageLimitResetPhrase(limit.resetAt, now);
  return {
    title: `${workspaceName?.trim() || "Your workspace"} used its OpenWork Models allowance`,
    reset: back ? `${limit.windowType ? windowNames[limit.windowType] : "Allowance"} resets ${back}` : null,
  };
}

export type UsageLimitKind = "free_auto" | "models_allowance";
export type UsageLimitActionId = "sign_in" | "get_models" | "add_team_provider" | "upgrade_plan" | "ask_admin" | "use_another_model";
export type UsageLimitAction = {
  id: UsageLimitActionId;
  label: string;
  /** The one primary action, an optional secondary, and the quiet way to keep working. */
  emphasis: "primary" | "secondary" | "tertiary";
  /** Present but not for this person: a lock that says who can (DESIGN P4). */
  lockedReason?: string;
};

export type UsageLimitViewer = {
  signedIn: boolean;
  /** Owner or admin of the active organization: the roles that can buy and add providers by default. */
  canBuy: boolean;
  /** OpenWork Models is sold on this control plane (hosted OpenWork Cloud). */
  modelsOffered: boolean;
  /** A higher plan can be bought for this organization. */
  planUpgrade?: boolean;
};

const useAnotherModel: UsageLimitAction = { id: "use_another_model", label: "Use another model", emphasis: "tertiary" };

/**
 * One primary action for the person's role, always a paid path for someone who can buy, and always a way to keep
 * working. The order is fixed: primary, secondary, tertiary.
 */
export function usageLimitActions(kind: UsageLimitKind, viewer: UsageLimitViewer): UsageLimitAction[] {
  if (kind === "free_auto") {
    if (!viewer.signedIn) {
      return [
        { id: "sign_in", label: "Sign in for more free use", emphasis: "primary" },
        ...(viewer.modelsOffered ? [{ id: "get_models", label: "Get OpenWork Models", emphasis: "secondary" } satisfies UsageLimitAction] : []),
        useAnotherModel,
      ];
    }
    if (!viewer.modelsOffered) return [{ ...useAnotherModel, emphasis: "primary" }];
    return viewer.canBuy
      ? [{ id: "get_models", label: "Get OpenWork Models", emphasis: "primary" }, useAnotherModel]
      : [{ id: "ask_admin", label: "Ask an admin for OpenWork Models", emphasis: "primary", lockedReason: "Only owners and admins can get OpenWork Models" }, useAnotherModel];
  }
  if (!viewer.canBuy) {
    return [{ id: "ask_admin", label: "Ask an admin for more", emphasis: "primary", lockedReason: "Owners and admins can add a team provider or upgrade the plan" }, useAnotherModel];
  }
  return [
    { id: "add_team_provider", label: "Add a team provider", emphasis: "primary" },
    ...(viewer.planUpgrade ? [{ id: "upgrade_plan", label: "Upgrade plan", emphasis: "secondary" } satisfies UsageLimitAction] : []),
    useAnotherModel,
  ];
}
