import { z } from "zod";
import type { ModelRef } from "../types";
import { AUTO_MODEL_ID, AUTO_PROVIDER_ID, isAutoModel } from "@/react-app/domains/models/model-catalog";

export const desktopFreeAccessStatusSchema = z.object({
  state: z.enum(["ready", "update_required", "unavailable", "exhausted"]),
  code: z.string().nullable(),
  currentVersion: z.string(),
  minimumVersion: z.string().nullable(),
  providerID: z.string(),
  modelID: z.string(),
  allowance: z.object({ resetsAt: z.string(), limitUsd: z.number().finite().nonnegative(), usedUsd: z.number().finite().nonnegative(), reservedUsd: z.number().finite().nonnegative(), remainingUsd: z.number().finite().nonnegative() }).nullable(),
  defaultPinned: z.boolean().optional(),
  // The desktop server has already verified the version floor for guests; signed-in members have none.
}).refine((status) => status.state !== "ready" || Boolean(status.allowance), "Ready Auto access requires a verified allowance");
export type DesktopFreeAccessStatus = z.infer<typeof desktopFreeAccessStatusSchema>;
export const autoAccessWallSchema = z.object({ state: z.enum(["limit", "update", "unavailable", "sync"]), resetsAt: z.string().optional(), minimumVersion: z.string().optional() });
export type AutoAccessWall = z.infer<typeof autoAccessWallSchema>;
export function messageAutoAccessWall(metadata: unknown) {
  const parsed = autoAccessWallSchema.safeParse(metadata && typeof metadata === "object" ? Reflect.get(metadata, "autoAccessWall") : null);
  return parsed.success ? parsed.data : null;
}
export type AutoAccessBlock = { outcome: "blocked"; reason: "auto-access"; wall: AutoAccessWall };
export class AutoAccessRejected extends Error {
  constructor(readonly wall: AutoAccessWall) { super("Auto access blocked"); }
}
export const autoAccessRefreshEvent = "openwork.auto-access-refresh";
export const openComposerModelPickerEvent = "openwork-open-composer-model-picker";

export function unavailableDesktopFreeStatus(): DesktopFreeAccessStatus {
  return { state: "unavailable", code: null, currentVersion: "", minimumVersion: null,
    providerID: AUTO_PROVIDER_ID, modelID: AUTO_MODEL_ID, allowance: null };
}

export function autoAccessWall(status: DesktopFreeAccessStatus): AutoAccessWall | null {
  if (status.state === "ready") return null;
  return { state: status.state === "exhausted" ? "limit" : status.state === "update_required" ? "update" : "unavailable",
    resetsAt: status.allowance?.resetsAt, minimumVersion: status.minimumVersion ?? undefined };
}

export function autoAccessWallFromError(value: unknown, model?: ModelRef | null, depth = 0): AutoAccessWall | null {
  if ((model && !isAutoModel(model)) || depth > 6 || value == null) return null;
  if (typeof value === "string") {
    if (value.length > 65_536 || !value.trimStart().startsWith("{")) return null;
    try { return autoAccessWallFromError(JSON.parse(value), model, depth + 1); } catch { return null; }
  }
  if (typeof value !== "object") return null;
  const parsed = desktopFreeAccessStatusSchema.safeParse(value);
  if (parsed.success) return autoAccessWall(parsed.data);
  const code = Reflect.get(value, "code");
  if (code === "desktop_update_required") {
    const minimumVersion = Reflect.get(value, "minimumVersion");
    return typeof minimumVersion === "string" && minimumVersion.trim() ? { state: "update", minimumVersion } : { state: "update" };
  }
  if (["anonymous_limit_exceeded", "anonymous_reservation_does_not_fit", "free_allowance_exhausted"].includes(code)) return { state: "limit" };
  if (["desktop_version_unavailable", "anonymous_capacity_exceeded", "anonymous_unavailable"].includes(code)) return { state: "unavailable" };
  if (code === "model_sync_pending") return { state: "sync" };
  for (const key of ["details", "error", "data", "responseBody", "message", "cause"]) {
    const wall = autoAccessWallFromError(Reflect.get(value, key), model, depth + 1);
    if (wall) return wall;
  }
  return null;
}

export async function preflightAutoSubmission(input: {
  model: ModelRef;
  client: { desktopFreePreflight: () => Promise<DesktopFreeAccessStatus> };
  isCurrent: () => boolean;
}): Promise<AutoAccessBlock | { outcome: "cancelled"; reason: "context_changed" } | null> {
  if (input.model.providerID !== AUTO_PROVIDER_ID || !isAutoModel(input.model)) return null;
  if (!input.isCurrent()) return { outcome: "cancelled", reason: "context_changed" };
  const status = await input.client.desktopFreePreflight().catch(() => unavailableDesktopFreeStatus());
  if (!input.isCurrent()) return { outcome: "cancelled", reason: "context_changed" };
  const wall = autoAccessWall(status);
  return wall ? { outcome: "blocked", reason: "auto-access", wall } : null;
}

export type AutoPickerState = "ready" | "exhausted" | "update_required" | "unavailable" | "sync";
/** "v0.18.51 or newer" when the gateway told us the oldest supported release. */
export function autoUpdateTarget(minimumVersion?: string | null) {
  const version = minimumVersion?.trim().replace(/^v/, "");
  return version ? `OpenWork v${version} or newer` : "OpenWork";
}
export function autoPickerCopy(state: AutoPickerState, signedIn: boolean, minimumVersion?: string | null) {
  switch (state) {
    case "exhausted": return { subtitle: "Free limit used up · resets Monday", detail: signedIn ? "This week’s free limit is used up. It resets Monday." : "This week’s free limit is used up. Sign in for a larger free limit.", action: signedIn ? null : "Sign in" };
    case "update_required": return { subtitle: "Free · needs an OpenWork update", detail: `Update to ${autoUpdateTarget(minimumVersion)} to keep using Auto. Your draft is kept.`, action: "Update" };
    case "unavailable": return { subtitle: "Free · temporarily unavailable", detail: "Auto is having trouble right now. Other models still work.", action: "Retry" };
    case "sync": return { subtitle: "Free · finishing setup", detail: "Auto is almost ready. Reload the workspace if it doesn’t appear.", action: "Reload" };
    case "ready": return { subtitle: "Free · OpenWork picks the model", detail: "Free access ready", action: null };
  }
}

export function autoWallCopy(wall: AutoAccessWall, signedIn: boolean) {
  switch (wall.state) {
    case "limit": return { title: "This week’s free limit is used up", detail: signedIn ? "Auto is free for your account up to a weekly limit. It resets Monday. Switch model and send again." : "Auto is free on this device up to a weekly limit. It resets Monday. Sign in to OpenWork for a larger free limit, or switch model and send again." };
    case "update": return { title: "Update OpenWork to use Auto", detail: `Your message was not processed. Update to ${autoUpdateTarget(wall.minimumVersion)} or switch to another model.` };
    case "sync": return { title: "Auto is still syncing", detail: "Your message was not processed. Wait for sync or switch to another model." };
    case "unavailable": return { title: "Auto is temporarily unavailable", detail: "Your message was not processed. Switch to another model or try again later." };
  }
}

export function openAlternativeModelPicker(sessionId: string) {
  window.dispatchEvent(new CustomEvent(openComposerModelPickerEvent, { detail: { sessionId, focusAlternative: true } }));
}
