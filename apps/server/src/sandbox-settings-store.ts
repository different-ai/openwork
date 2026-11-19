import { createHash } from "node:crypto";
import { z } from "zod";
import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore } from "./workspace-kv-store.js";

export const sandboxSettingsSchema = z.object({ useSandbox: z.boolean(), forceSandbox: z.boolean() }).strict();
const legacySchema = z.object({ allowHostExecution: z.boolean() }).strict();
export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;
export const sandboxSettingsUpdateSchema = z.union([
  sandboxSettingsSchema.partial().refine(value => value.useSandbox !== undefined || value.forceSandbox !== undefined),
  legacySchema.transform(({ allowHostExecution }) => ({ useSandbox: !allowHostExecution, forceSandbox: !allowHostExecution })),
]);
const revisions = new WeakMap<ServerConfig, number>();
export function sandboxSettingsRevision(config: ServerConfig): number { return revisions.get(config) ?? 0; }
function normalize(settings: SandboxSettings): SandboxSettings {
  return { useSandbox: settings.useSandbox || settings.forceSandbox, forceSandbox: settings.forceSandbox };
}
function parseSettings(json: string): SandboxSettings {
  try {
    const value: unknown = JSON.parse(json);
    const current = sandboxSettingsSchema.safeParse(value);
    if (current.success) return normalize(current.data);
    const { allowHostExecution } = legacySchema.parse(value);
    return { useSandbox: !allowHostExecution, forceSandbox: !allowHostExecution };
  } catch { return { useSandbox: true, forceSandbox: true }; }
}
const ENGINE_GLOBAL = "__openwork_engine_global__";
const store = createWorkspaceKvStore<SandboxSettings>({
  tableName: "runtime_sandbox_settings", valueColumn: "settings_json",
  // A corrupt explicit preference must not grant host access.
  parse: parseSettings,
  serialize: value => JSON.stringify(sandboxSettingsSchema.parse(value)),
});
/** This setting is host-owned. Never import it from a workspace file or engine config. */
export async function readSandboxSettings(config: ServerConfig): Promise<SandboxSettings> {
  return await store.get(config, ENGINE_GLOBAL) ?? { useSandbox: false, forceSandbox: false };
}
export async function writeSandboxSettings(config: ServerConfig, value: SandboxSettings): Promise<void> {
  await store.set(config, ENGINE_GLOBAL, normalize(sandboxSettingsSchema.parse(value)));
  revisions.set(config, sandboxSettingsRevision(config) + 1);
}

const updates = new WeakMap<ServerConfig, Promise<unknown>>();
/** Merge partial choices against the latest saved row, including concurrent saves. */
export function updateSandboxSettings(config: ServerConfig, update: Partial<SandboxSettings>) {
  const pending = (updates.get(config) ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const previous = await readSandboxSettings(config);
    const forceSandbox = update.forceSandbox ?? (update.useSandbox !== false && previous.forceSandbox);
    const settings = normalize({ useSandbox: update.useSandbox ?? previous.useSandbox, forceSandbox });
    if (settings.useSandbox !== previous.useSandbox || settings.forceSandbox !== previous.forceSandbox) await writeSandboxSettings(config, settings);
    return { previous, settings };
  });
  updates.set(config, pending);
  void pending.finally(() => { if (updates.get(config) === pending) updates.delete(config); }).catch(() => undefined);
  return pending;
}

const appliedStore = createWorkspaceKvStore<SandboxSettings>({
  tableName: "runtime_sandbox_applied_settings", valueColumn: "settings_json",
  parse: parseSettings,
  serialize: value => JSON.stringify(sandboxSettingsSchema.parse(value)),
});
/** Local policy installed for current tasks. Never use desired intent to revoke
 * an active turn's local permission; organization rules remain independently live. */
export async function readAppliedSandboxSettings(config: ServerConfig): Promise<SandboxSettings> {
  return await appliedStore.get(config, ENGINE_GLOBAL) ?? await readSandboxSettings(config);
}
/** Only the engine owner may advance applied policy: before cold startup or
 * after the old process and all native jobs have passed the idle boundary. */
export async function applySandboxSettings(config: ServerConfig): Promise<void> {
  await appliedStore.set(config, ENGINE_GLOBAL, await readSandboxSettings(config));
}

const requirementStore = createWorkspaceKvStore<boolean>({
  tableName: "runtime_sandbox_requirements", valueColumn: "required_json",
  parse: json => json !== "false", serialize: value => JSON.stringify(value),
});
function authorityKey(baseUrl: string, organizationId: string): string {
  return createHash("sha256").update(`${new URL(baseUrl).origin}\n${organizationId}`).digest("hex");
}
/** Persist only restrictive knowledge, scoped to a verified control plane and
 * org. It can never grant host execution. A fresh policy removes a stale deny.
 * Deliberately conservative across members of the same org after offline restart. */
export async function readSandboxRequirement(config: ServerConfig, baseUrl: string, organizationId: string): Promise<boolean> {
  return await requirementStore.get(config, authorityKey(baseUrl, organizationId)) ?? false;
}
export async function writeSandboxRequirement(config: ServerConfig, baseUrl: string, organizationId: string, required: boolean): Promise<void> {
  await requirementStore.set(config, authorityKey(baseUrl, organizationId), required);
}
