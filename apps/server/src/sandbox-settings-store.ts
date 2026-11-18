import { createHash } from "node:crypto";
import { z } from "zod";
import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore } from "./workspace-kv-store.js";

export const sandboxSettingsSchema = z.object({ allowHostExecution: z.boolean() }).strict();
export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;
const ENGINE_GLOBAL = "__openwork_engine_global__";
const store = createWorkspaceKvStore<SandboxSettings>({
  tableName: "runtime_sandbox_settings", valueColumn: "settings_json",
  // A corrupt explicit preference must not grant host access.
  parse: json => {
    try { return sandboxSettingsSchema.parse(JSON.parse(json)); }
    catch { return { allowHostExecution: false }; }
  },
  serialize: value => JSON.stringify(sandboxSettingsSchema.parse(value)),
});
/** This setting is host-owned. Never import it from a workspace file or engine config. */
export async function readSandboxSettings(config: ServerConfig): Promise<SandboxSettings> {
  return await store.get(config, ENGINE_GLOBAL) ?? { allowHostExecution: true };
}
export async function writeSandboxSettings(config: ServerConfig, value: SandboxSettings): Promise<void> {
  await store.set(config, ENGINE_GLOBAL, sandboxSettingsSchema.parse(value));
}

const appliedStore = createWorkspaceKvStore<SandboxSettings>({
  tableName: "runtime_sandbox_applied_settings", valueColumn: "settings_json",
  parse: json => {
    try { return sandboxSettingsSchema.parse(JSON.parse(json)); }
    catch { return { allowHostExecution: false }; }
  },
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
