import { z } from "zod";
import { computerToolSchemas, type SandboxToolName } from "../sandbox-tool-host.js";
import { shellPermissions } from "./shell-permissions.js";

const requestSchema = z.object({ action: z.string(), resources: z.array(z.string()), save: z.array(z.string()), confirm: z.boolean().optional() });
type PermissionRequest = z.infer<typeof requestSchema>;
export const computerPermissionsSchema = z.object({ bindingId: z.string(), label: z.string(), requests: z.array(requestSchema).min(1) });
export type ComputerPermissions = z.infer<typeof computerPermissionsSchema>;

export function computerPermissionRequests(tool: SandboxToolName, translated: unknown): PermissionRequest[] {
  switch (tool) {
    case "shell": return [shellPermissions(computerToolSchemas.shell.parse(translated).command)];
    case "write":
    case "edit":
    case "read": {
      const { path, filePath } = computerToolSchemas[tool].parse(translated);
      return [{ action: tool === "read" ? "read" : "edit", resources: [z.string().parse(path ?? filePath)], save: ["*"] }];
    }
    case "glob":
    case "grep": return [{ action: tool, resources: [computerToolSchemas[tool].parse(translated).pattern], save: ["*"] }];
  }
}
