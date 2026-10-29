import type { ModelRef } from "@/app/types";
import { publicModelTitle } from "@/react-app/domains/models/model-catalog";

export type RememberedModel = ModelRef & { title: string };
const STORAGE_KEY = "openwork.modelDisplayMemory.v1";
const MAX_MODELS = 200;
const MAX_SCOPES = 20;

function storedScopes(): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : {};
  } catch { return {}; }
}

/** Display-only, account/workspace scoped. Never used as entitlement or routing evidence. */
export function readModelDisplayMemory(scope: string): Map<string, RememberedModel> {
  const records = storedScopes()[scope];
  if (!Array.isArray(records)) return new Map();
  const models = new Map<string, RememberedModel>();
  for (const value of records.slice(-MAX_MODELS)) {
    if (typeof value !== "object" || value === null) continue;
    const providerID: unknown = Reflect.get(value, "providerID");
    const modelID: unknown = Reflect.get(value, "modelID");
    const title: unknown = Reflect.get(value, "title");
    if (typeof providerID !== "string" || typeof modelID !== "string" || typeof title !== "string") continue;
    const model = { providerID, modelID, title };
    if (publicModelTitle(model)) models.set(`${providerID}/${modelID}`, model);
  }
  return models;
}

export function rememberModelDisplayNames(scope: string, models: Map<string, RememberedModel>, options: readonly (ModelRef & { title?: string })[]) {
  for (const option of options) {
    const title = publicModelTitle(option);
    if (!title) continue;
    const key = `${option.providerID}/${option.modelID}`;
    models.delete(key);
    models.set(key, { providerID: option.providerID, modelID: option.modelID, title });
  }
  while (models.size > MAX_MODELS) {
    const oldest = models.keys().next().value;
    if (oldest === undefined) break;
    models.delete(oldest);
  }
  try {
    const scopes = storedScopes();
    delete scopes[scope];
    scopes[scope] = [...models.values()];
    const keys = Object.keys(scopes);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_SCOPES))) delete scopes[key];
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(scopes));
  } catch { /* Storage unavailable: the in-memory catalog still names warm-session removals. */ }
}
