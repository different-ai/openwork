import { z } from "zod";

import type { ServerConfig } from "./types.js";
import { createWorkspaceKvStore } from "./workspace-kv-store.js";

/**
 * The model a new chat in a workspace would use. The renderer owns the choice
 * and mirrors it here so background callers (automations, remote sessions,
 * cloud workers) can start sessions on the same model.
 */
const modelPart = z.string().trim().min(1).max(200);

export const workspaceDefaultModelSchema = z.object({
  providerID: modelPart,
  modelID: modelPart,
  variant: modelPart.optional(),
});

export type WorkspaceDefaultModel = z.infer<typeof workspaceDefaultModelSchema>;

export const workspaceDefaultModelBodySchema = z.object({
  model: workspaceDefaultModelSchema.nullable(),
});

export type WorkspaceDefaultModelState = {
  model: WorkspaceDefaultModel | null;
  updatedAt: number | null;
};

function parseStoredModel(json: string): WorkspaceDefaultModel | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = workspaceDefaultModelSchema.nullable().safeParse(value);
  return parsed.success ? parsed.data : null;
}

const workspaceDefaultModelStore = createWorkspaceKvStore<WorkspaceDefaultModel | null>({
  tableName: "workspace_default_models",
  valueColumn: "model_json",
  parse: parseStoredModel,
  serialize: (value) => JSON.stringify(value),
});

export async function readWorkspaceDefaultModel(
  config: ServerConfig,
  workspaceId: string,
): Promise<WorkspaceDefaultModelState> {
  const row = await workspaceDefaultModelStore.getRow(config, workspaceId);
  if (!row) return { model: null, updatedAt: null };
  return { model: row.value, updatedAt: row.updatedAt };
}

export async function writeWorkspaceDefaultModel(
  config: ServerConfig,
  workspaceId: string,
  model: WorkspaceDefaultModel | null,
): Promise<WorkspaceDefaultModelState> {
  const updatedAt = Date.now();
  await workspaceDefaultModelStore.set(config, workspaceId, model, updatedAt);
  return { model, updatedAt };
}
