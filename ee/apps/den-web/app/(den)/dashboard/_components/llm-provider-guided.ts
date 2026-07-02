/**
 * Guided (form-based) custom provider setup for the Den dashboard.
 *
 * Admins describe an OpenAI-compatible endpoint (Azure AI Foundry, LiteLLM,
 * vLLM, an internal gateway) with a few fields; we generate the models.dev
 * style config the API already accepts — no JSON paste required. Pasting or
 * editing raw JSON stays available as the advanced escape hatch.
 */

type JsonRecord = Record<string, unknown>;

export const GUIDED_PROVIDER_NPM = "@ai-sdk/openai-compatible";
export const GUIDED_PROVIDER_NPM_OPENAI = "@ai-sdk/openai";

const GUIDED_PROVIDER_NPM_PACKAGES = new Set([GUIDED_PROVIDER_NPM, GUIDED_PROVIDER_NPM_OPENAI]);

const GUIDED_PROVIDER_CONFIG_KEYS = new Set(["id", "name", "npm", "env", "api", "doc"]);
const GUIDED_MODEL_KEYS = new Set(["id", "name"]);

export type GuidedCustomProviderFields = {
    providerId: string;
    baseUrl: string;
    modelIds: string[];
    envNames: string[];
    npm: string;
};

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function slugifyProviderId(value: string): string {
    return value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
}

export function isValidGuidedProviderId(value: string): boolean {
    return /^[a-z0-9][a-z0-9_-]*$/i.test(value);
}

export function parseGuidedModelIds(text: string): string[] {
    return [
        ...new Set(
            text
                .split(/[\n,]+/)
                .map((entry) => entry.trim())
                .filter(Boolean),
        ),
    ];
}

export function buildGuidedProviderEnvName(providerId: string): string {
    const normalized = providerId
        .trim()
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
    return `${normalized || "CUSTOM_PROVIDER"}_API_KEY`;
}

export function validateGuidedCustomProvider(input: {
    providerId: string;
    baseUrl: string;
    modelIds: string[];
}): string | null {
    if (!input.providerId.trim()) {
        return "Give this provider an ID (for example azure-foundry).";
    }
    if (!isValidGuidedProviderId(input.providerId.trim())) {
        return "Provider IDs can only contain letters, numbers, dashes, and underscores.";
    }
    if (!input.baseUrl.trim()) {
        return "Add the base URL of the OpenAI-compatible endpoint.";
    }
    if (!/^https?:\/\//i.test(input.baseUrl.trim())) {
        return "The base URL must start with http:// or https://";
    }
    if (input.modelIds.length === 0) {
        return "List at least one model ID.";
    }
    return null;
}

export function buildGuidedCustomProviderConfig(input: {
    providerId: string;
    name: string;
    baseUrl: string;
    modelIds: string[];
    envNames?: string[] | null;
    /** AI SDK package; verification may upgrade this to the OpenAI package. */
    npm?: string | null;
}): JsonRecord {
    const providerId = input.providerId.trim();
    const envNames = (input.envNames ?? [])
        .map((entry) => entry.trim())
        .filter(Boolean);
    return {
        id: providerId,
        name: input.name.trim() || providerId,
        npm: input.npm && GUIDED_PROVIDER_NPM_PACKAGES.has(input.npm) ? input.npm : GUIDED_PROVIDER_NPM,
        env: envNames.length > 0 ? envNames : [buildGuidedProviderEnvName(providerId)],
        api: input.baseUrl.trim().replace(/\/+$/, ""),
        models: input.modelIds.map((modelId) => ({ id: modelId, name: modelId })),
    };
}

/**
 * Try to read a provider config back into guided form fields. Returns null
 * when the config uses anything beyond the simple shape the form generates
 * (custom npm package, provider options, per-model metadata, ...) so the
 * editor falls back to JSON editing instead of silently dropping data.
 */
export function readGuidedCustomProviderFields(
    config: unknown,
): GuidedCustomProviderFields | null {
    if (!isRecord(config)) {
        return null;
    }

    const providerId = asString(config.id);
    if (!providerId) {
        return null;
    }

    const npm = asString(config.npm);
    if (!npm || !GUIDED_PROVIDER_NPM_PACKAGES.has(npm)) {
        return null;
    }

    for (const key of Object.keys(config)) {
        if (key === "models") continue;
        if (!GUIDED_PROVIDER_CONFIG_KEYS.has(key)) {
            return null;
        }
    }

    const baseUrl = asString(config.api);
    if (!baseUrl) {
        return null;
    }

    const env = Array.isArray(config.env)
        ? config.env.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        : [];

    const models = Array.isArray(config.models) ? config.models : null;
    if (!models || models.length === 0) {
        return null;
    }

    const modelIds: string[] = [];
    for (const model of models) {
        if (typeof model === "string") {
            modelIds.push(model);
            continue;
        }
        if (!isRecord(model)) {
            return null;
        }
        const id = asString(model.id);
        if (!id) {
            return null;
        }
        const name = asString(model.name);
        if (name !== null && name !== id) {
            return null;
        }
        for (const key of Object.keys(model)) {
            if (!GUIDED_MODEL_KEYS.has(key)) {
                return null;
            }
        }
        modelIds.push(id);
    }

    return {
        providerId,
        baseUrl,
        modelIds,
        envNames: env,
        npm,
    };
}

/**
 * Leniently pull the env var names out of pasted provider JSON so the editor
 * can render one credential input per env key even for configs too rich for
 * the guided form. Returns [] when the text is unparsable or lists no env.
 */
export function readEnvNamesFromCustomProviderText(text: string): string[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return [];
    }

    if (!isRecord(parsed)) {
        return [];
    }

    let block: JsonRecord = parsed;
    if (isRecord(parsed.provider)) {
        const entries = Object.values(parsed.provider).filter(isRecord);
        if (entries.length !== 1) {
            return [];
        }
        block = entries[0];
    }

    return Array.isArray(block.env)
        ? block.env.filter(
              (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
          )
        : [];
}

/**
 * Parse pasted JSON text into guided fields (used when switching from the
 * JSON editor back to the form). Accepts a bare provider block or an
 * opencode-style `{ "provider": { "<id>": { ... } } }` wrapper.
 */
export function readGuidedCustomProviderFieldsFromText(
    text: string,
): GuidedCustomProviderFields | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return null;
    }

    if (isRecord(parsed) && isRecord(parsed.provider)) {
        const entries = Object.entries(parsed.provider).filter(
            (entry): entry is [string, JsonRecord] => isRecord(entry[1]),
        );
        if (entries.length !== 1) {
            return null;
        }
        const [providerId, block] = entries[0];
        return readGuidedCustomProviderFields({ id: providerId, ...block });
    }

    return readGuidedCustomProviderFields(parsed);
}
