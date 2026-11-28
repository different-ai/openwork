import { randomUUID } from "node:crypto";
import { z } from "zod";
import { COMPUTER_KINDS, computerFolderSchema, computerSandboxScopeSchema } from "@openwork/types/den/computers";
import type { ServerConfig } from "../types.js";
import { createWorkspaceKvStore } from "../workspace-kv-store.js";

const bindingSchema = z.object({ id: z.string(), label: z.string(), folder: computerFolderSchema, revision: z.uuid().optional(), kind: z.enum(COMPUTER_KINDS).optional(), provider: z.string().optional(), shares: computerSandboxScopeSchema.optional() });
export type ComputerBinding = z.infer<typeof bindingSchema>;

export const bindingApprovalId = (binding: ComputerBinding) => binding.revision ?? binding.id;
const store = createWorkspaceKvStore({
  tableName: "session_computer_bindings",
  valueColumn: "binding_json",
  parse: (json) => bindingSchema.nullable().parse(JSON.parse(json)),
  serialize: (value) => JSON.stringify(value),
});

export function computerBindings(config: ServerConfig) {
  const key = (directory: string, rootId: string) => JSON.stringify([directory, rootId]);
  return {
    async get(directory: string, rootId: string) { return await store.get(config, key(directory, rootId)) ?? null; },
    set(directory: string, rootId: string, binding: ComputerBinding | null) {
      return store.set(config, key(directory, rootId), binding ? { ...binding, revision: randomUUID() } : null);
    },
  };
}
