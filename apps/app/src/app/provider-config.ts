import { parse } from "jsonc-parser";
import { readOpencodeConfig, writeOpencodeConfig } from "./lib/tauri";

/**
 * Provider configuration structure matching the opencode.json schema.
 */
export type CustomProviderConfig = {
  /** NPM package for the provider (e.g., "@ai-sdk/openai-compatible") */
  npm?: string;
  /** Display name for the provider */
  name?: string;
  /** API type identifier */
  api?: string;
  /** Environment variable names for credentials */
  env?: string[];
  /** Provider-specific options */
  options?: {
    /** API base URL */
    baseURL?: string;
    /** API key (stored in plaintext - warn users) */
    apiKey?: string;
    /** Request timeout in milliseconds */
    timeout?: number | false;
    /** Additional provider-specific options */
    [key: string]: unknown;
  };
  /** Model configurations */
  models?: {
    [modelId: string]: {
      /** Display name for the model */
      name?: string;
      /** Model family */
      family?: string;
      /** Cost configuration */
      cost?: {
        input: number;
        output: number;
        cache_read?: number;
        cache_write?: number;
      };
      /** Context limits */
      limit?: {
        context: number;
        input?: number;
        output: number;
      };
      /** Additional model-specific options */
      [key: string]: unknown;
    };
  };
  /** Allowed model IDs (whitelist) */
  whitelist?: string[];
  /** Blocked model IDs (blacklist) */
  blacklist?: string[];
};

/**
 * Custom provider entry with ID and config.
 */
export type CustomProviderEntry = {
  id: string;
  config: CustomProviderConfig;
};

type ProviderConfigValue = Record<string, unknown> | null | undefined;

/**
 * Validates a provider ID string.
 * Must be alphanumeric with '-' or '_', and not start with '-'.
 *
 * @param id - The provider ID to validate
 * @returns The trimmed and validated provider ID
 * @throws Error if the ID is invalid
 */
export function validateProviderId(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) {
    throw new Error("Provider ID is required");
  }
  if (trimmed.startsWith("-")) {
    throw new Error("Provider ID must not start with '-'");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error("Provider ID must be alphanumeric with '-' or '_'");
  }
  if (trimmed.length > 64) {
    throw new Error("Provider ID must be 64 characters or less");
  }
  return trimmed;
}

/**
 * Validates a URL string.
 * Must be a valid HTTP or HTTPS URL.
 *
 * @param url - The URL to validate
 * @returns The trimmed URL or empty string if not provided
 * @throws Error if the URL is invalid
 */
export function validateBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("URL must use http or https protocol");
    }
    return trimmed;
  } catch {
    throw new Error("Invalid URL format");
  }
}

/**
 * Adds a custom provider to the opencode.json configuration file.
 *
 * @param projectDir - The project directory path
 * @param providerId - The unique provider identifier
 * @param config - The provider configuration
 * @throws Error if the provider ID is invalid or already exists, or if writing fails
 */
export async function addCustomProviderToConfig(
  projectDir: string,
  providerId: string,
  config: CustomProviderConfig,
): Promise<void> {
  const validatedId = validateProviderId(providerId);

  const configFile = await readOpencodeConfig("project", projectDir);
  let existingConfig: Record<string, unknown> = {};

  if (configFile.exists && configFile.content?.trim()) {
    try {
      existingConfig = parse(configFile.content) ?? {};
    } catch {
      existingConfig = {};
    }
  }

  // Get or create the provider section
  const providerSection = (existingConfig["provider"] as ProviderConfigValue) ?? {};

  // Check if provider already exists
  if (providerSection && validatedId in providerSection) {
    throw new Error(`Provider "${validatedId}" already exists. Use a different ID or delete the existing provider first.`);
  }

  // Add the new provider
  existingConfig = {
    ...existingConfig,
    provider: {
      ...providerSection,
      [validatedId]: config,
    },
  };

  const writeResult = await writeOpencodeConfig(
    "project",
    projectDir,
    `${JSON.stringify(existingConfig, null, 2)}\n`,
  );

  if (!writeResult.ok) {
    throw new Error(writeResult.stderr || writeResult.stdout || "Failed to write opencode.json");
  }
}

/**
 * Updates an existing custom provider in the opencode.json configuration file.
 *
 * @param projectDir - The project directory path
 * @param providerId - The unique provider identifier
 * @param config - The updated provider configuration
 * @throws Error if the provider ID is invalid or doesn't exist, or if writing fails
 */
export async function updateCustomProviderInConfig(
  projectDir: string,
  providerId: string,
  config: CustomProviderConfig,
): Promise<void> {
  const validatedId = validateProviderId(providerId);

  const configFile = await readOpencodeConfig("project", projectDir);
  let existingConfig: Record<string, unknown> = {};

  if (configFile.exists && configFile.content?.trim()) {
    try {
      existingConfig = parse(configFile.content) ?? {};
    } catch {
      existingConfig = {};
    }
  }

  const providerSection = existingConfig["provider"] as ProviderConfigValue;

  if (!providerSection || !(validatedId in providerSection)) {
    throw new Error(`Provider "${validatedId}" does not exist`);
  }

  // Update the provider
  existingConfig = {
    ...existingConfig,
    provider: {
      ...providerSection,
      [validatedId]: config,
    },
  };

  const writeResult = await writeOpencodeConfig(
    "project",
    projectDir,
    `${JSON.stringify(existingConfig, null, 2)}\n`,
  );

  if (!writeResult.ok) {
    throw new Error(writeResult.stderr || writeResult.stdout || "Failed to write opencode.json");
  }
}

/**
 * Removes a custom provider from the opencode.json configuration file.
 *
 * @param projectDir - The project directory path
 * @param providerId - The unique provider identifier
 * @throws Error if the provider ID is invalid or if writing fails
 */
export async function removeCustomProviderFromConfig(
  projectDir: string,
  providerId: string,
): Promise<void> {
  const validatedId = validateProviderId(providerId);

  const configFile = await readOpencodeConfig("project", projectDir);
  let existingConfig: Record<string, unknown> = {};

  if (configFile.exists && configFile.content?.trim()) {
    try {
      existingConfig = parse(configFile.content) ?? {};
    } catch {
      existingConfig = {};
    }
  }

  const providerSection = existingConfig["provider"] as ProviderConfigValue;
  if (!providerSection || !(validatedId in providerSection)) {
    return; // Provider doesn't exist, nothing to do
  }

  delete providerSection[validatedId];

  const writeResult = await writeOpencodeConfig(
    "project",
    projectDir,
    `${JSON.stringify(existingConfig, null, 2)}\n`,
  );

  if (!writeResult.ok) {
    throw new Error(writeResult.stderr || writeResult.stdout || "Failed to write opencode.json");
  }
}

/**
 * Parses custom providers from opencode.json content.
 * Only returns providers that have npm or api fields (indicating custom providers).
 *
 * @param content - The opencode.json file content
 * @returns A map of provider IDs to their configurations
 */
export function parseCustomProvidersFromContent(content: string): CustomProviderEntry[] {
  if (!content.trim()) return [];

  try {
    const parsed = parse(content) as Record<string, unknown> | undefined;
    const provider = parsed?.provider as ProviderConfigValue;

    if (!provider || typeof provider !== "object") {
      return [];
    }

    // Filter to only custom providers (those with npm or api fields)
    return Object.entries(provider)
      .filter(([, config]) => {
        if (!config || typeof config !== "object") {
          return false;
        }
        const pc = config as CustomProviderConfig;
        // Custom providers have npm or api field
        return !!(pc.npm || pc.api);
      })
      .map(([id, config]) => ({
        id,
        config: config as CustomProviderConfig,
      }));
  } catch {
    return [];
  }
}

/**
 * Checks if a provider ID already exists in the configuration.
 *
 * @param projectDir - The project directory path
 * @param providerId - The provider ID to check
 * @returns True if the provider exists, false otherwise
 */
export async function providerExists(
  projectDir: string,
  providerId: string,
): Promise<boolean> {
  const validatedId = validateProviderId(providerId);

  const configFile = await readOpencodeConfig("project", projectDir);
  if (!configFile.exists || !configFile.content?.trim()) {
    return false;
  }

  try {
    const parsed = parse(configFile.content) as Record<string, unknown> | undefined;
    const provider = parsed?.provider as ProviderConfigValue;
    return !!(provider && validatedId in provider);
  } catch {
    return false;
  }
}

/**
 * Gets all custom providers from the opencode.json configuration file.
 *
 * @param projectDir - The project directory path
 * @returns Array of custom provider entries
 */
export async function getCustomProviders(
  projectDir: string,
): Promise<CustomProviderEntry[]> {
  const configFile = await readOpencodeConfig("project", projectDir);
  if (!configFile.exists || !configFile.content?.trim()) {
    return [];
  }

  return parseCustomProvidersFromContent(configFile.content);
}

/**
 * Preset templates for common custom providers.
 */
export const PROVIDER_PRESETS = {
  ollama: {
    name: "Ollama",
    npm: "@ai-sdk/ollama",
    defaultBaseURL: "http://localhost:11434",
    description: "Local LLM server (Ollama)",
  },
  vllm: {
    name: "vLLM",
    npm: "@ai-sdk/openai-compatible",
    defaultBaseURL: "http://localhost:8000/v1",
    description: "vLLM inference server",
  },
  openaiCompatible: {
    name: "OpenAI Compatible",
    npm: "@ai-sdk/openai-compatible",
    defaultBaseURL: "",
    description: "Any OpenAI-compatible API",
  },
} as const;

export type ProviderPresetKey = keyof typeof PROVIDER_PRESETS;
