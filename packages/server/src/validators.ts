import { ApiError } from "./errors.js";

const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const COMMAND_NAME_REGEX = /^[A-Za-z0-9_-]+$/;
const MCP_NAME_REGEX = /^[A-Za-z0-9_-]+$/;

export function validateSkillName(name: string): void {
  if (!name || name.length < 1 || name.length > 64 || !SKILL_NAME_REGEX.test(name)) {
    throw new ApiError(400, "invalid_skill_name", "Skill name must be kebab-case (1-64 chars)");
  }
}

export function validateDescription(description: string | undefined): void {
  if (!description || description.length < 1 || description.length > 1024) {
    throw new ApiError(422, "invalid_description", "Description must be 1-1024 characters");
  }
}

export function validatePluginSpec(spec: string): void {
  if (!spec || spec.trim().length === 0) {
    throw new ApiError(400, "invalid_plugin_spec", "Plugin spec is required");
  }
}

export function sanitizeCommandName(name: string): string {
  const trimmed = name.trim().replace(/^\/+/, "");
  return trimmed;
}

export function validateCommandName(name: string): void {
  if (!name || !COMMAND_NAME_REGEX.test(name)) {
    throw new ApiError(400, "invalid_command_name", "Command name must be alphanumeric with _ or -");
  }
}

export function validateMcpName(name: string): void {
  if (!name || name.startsWith("-") || !MCP_NAME_REGEX.test(name)) {
    throw new ApiError(400, "invalid_mcp_name", "MCP name must be alphanumeric and not start with -");
  }
}

export function validateMcpConfig(config: Record<string, unknown>): void {
  const type = config.type;
  if (type !== "local" && type !== "remote") {
    throw new ApiError(400, "invalid_mcp_config", "MCP config type must be local or remote");
  }
  if (type === "local") {
    const command = config.command;
    if (!Array.isArray(command) || command.length === 0) {
      throw new ApiError(400, "invalid_mcp_config", "Local MCP requires command array");
    }
  }
  if (type === "remote") {
    const url = config.url;
    if (!url || typeof url !== "string") {
      throw new ApiError(400, "invalid_mcp_config", "Remote MCP requires url");
    }
  }
}
