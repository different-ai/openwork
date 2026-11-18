import { parse as parseJsonc } from "jsonc-parser";
import { ApiError } from "./errors.js";
import { isOrganizationMcpName } from "./organization-mcp-names.js";

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

/**
 * Provider ids only OpenWork's own sync may define. The Smart Router provider
 * passes the "only your organization's providers" policy by id, so a client
 * write that defines it could point Smart at any endpoint; such writes are refused. Removing
 * one (`null`) stays allowed.
 */
const RESERVED_PROVIDER_IDS = new Set(["openwork-auto"]);

export function isReservedProviderId(id: string): boolean {
  return RESERVED_PROVIDER_IDS.has(id.trim().toLowerCase());
}

export function validateUserProviderUpdate(update: Record<string, unknown>): void {
  for (const [id, value] of Object.entries(update)) {
    if (value !== null && isReservedProviderId(id)) {
      throw new ApiError(409, "reserved_provider_id", `${id} is managed by your organization and can't be changed here`);
    }
  }
}

function hasReservedProviderKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasReservedProviderKey);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(([key, child]) => isReservedProviderId(key) || hasReservedProviderKey(child));
}

/**
 * Refuses OpenCode config text (JSON or JSONC) that defines a reserved
 * provider. Keys are checked after JSONC decoding, so escaped spellings
 * (`openwork-\u0061uto`) are caught too.
 */
export function validateUserOpencodeConfigText(content: string): void {
  const parsed: unknown = parseJsonc(content, [], { allowTrailingComma: true, disallowComments: false });
  if (hasReservedProviderKey(parsed)) {
    throw new ApiError(409, "reserved_provider_id", "openwork-auto is managed by your organization and can't be defined in OpenCode config");
  }
}

export function validateUserMcpName(name: string): void {
  validateMcpName(name);
  if (isOrganizationMcpName(name)) {
    throw new ApiError(409, "reserved_mcp_name", `${name} is reserved for OpenWork Connect`);
  }
}

export function validateMcpConfig(config: Record<string, unknown>): void {
  const type = config.type;
  if (type !== "local" && type !== "remote") {
    throw new ApiError(400, "invalid_mcp_config", "MCP config type must be local or remote");
  }
  if (type === "local") {
    const command = config.command;
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      command.some((part) => typeof part !== "string" || part.trim().length === 0)
    ) {
      throw new ApiError(400, "invalid_mcp_config", "Local MCP requires command array");
    }
  }
  if (type === "remote") {
    const url = config.url;
    if (!url || typeof url !== "string" || url.trim().length === 0) {
      throw new ApiError(400, "invalid_mcp_config", "Remote MCP requires url");
    }
    const normalizedUrl = url.trim();
    if (url !== normalizedUrl) {
      throw new ApiError(400, "invalid_mcp_config", "Remote MCP url must not include surrounding whitespace");
    }
    if (!/^https?:\/\//i.test(normalizedUrl)) {
      throw new ApiError(400, "invalid_mcp_config", "Remote MCP url must start with http(s)://");
    }
    try {
      const parsed = new URL(normalizedUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new ApiError(400, "invalid_mcp_config", "Remote MCP url must use http(s)");
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, "invalid_mcp_config", "Remote MCP requires a valid url");
    }
  }
}
