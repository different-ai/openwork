import { z } from "zod";
import { computerFolderSchema } from "@openwork/types/den/computers";
import type { ServerConfig } from "../types.js";
import { createWorkspaceKvStore } from "../workspace-kv-store.js";

const bindingSchema = z.object({ id: z.string(), label: z.string(), folder: computerFolderSchema });
export type ComputerBinding = z.infer<typeof bindingSchema>;
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
    set(directory: string, rootId: string, binding: ComputerBinding | null) { return store.set(config, key(directory, rootId), binding); },
  };
}
