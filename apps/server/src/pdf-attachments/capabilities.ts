/**
 * What the current model can take as input, read from the engine's provider
 * catalog. Both catalog shapes the OpenCode SDK has shipped are understood:
 * `capabilities.input.{pdf,image}` and the older `modalities.input` list.
 *
 * Unknown models are treated as text-only. That is the safe direction: text
 * always works, while an unsupported PDF or image part fails the whole request
 * at the provider.
 */
export type ModelInputSupport = {
  pdf: boolean;
  image: boolean;
  /** false when the model was not found in the catalog. */
  known: boolean;
  /** AI SDK package serving the model, when the catalog says. */
  npm: string | null;
  /** Context window in tokens, when the catalog says. */
  contextTokens: number | null;
};

/**
 * When a PDF-capable model should still get the derived form instead of the
 * PDF itself. A PDF sent natively rides inline as base64 in every step of the
 * loop and is tokenized page by page, so past a point it costs more than it
 * gives: it can exceed the provider's request size, dominate the context
 * window, or re-upload tens of megabytes per tool call.
 */
export type NativePdfPolicy = {
  /** Provider ceiling for one request body; PDFs count at their base64 size. */
  requestBytes: number;
  /** Bytes kept free for the rest of the request (prompt, tools, history). */
  requestHeadroomBytes: number;
  /** Provider cap on PDF pages per request. */
  maxPages: number;
  /** Raw size above which native input is not worth re-uploading every step. */
  maxRawBytes: number;
  /** Share of the context window that natively-sent PDFs may take in one step. */
  contextShare: number;
  /** Rough provider tokenization of one native PDF page (text plus page image). */
  tokensPerPage: number;
};

const MIB = 1024 * 1024;
const CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_FAILURE_TTL_MS = 30_000;

export const TEXT_ONLY: ModelInputSupport = { pdf: false, image: false, known: false, npm: null, contextTokens: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Native-input policy per provider package, from the providers' own documented
 * limits with conservative defaults elsewhere:
 * - Anthropic: 32 MB per request; 100 pages, or 600 when the context window is
 *   at least 1M tokens; about 2,300 tokens per page (text plus page image).
 * - OpenAI: text plus page images per page; 50 MB per request (kept at 32 MB).
 * - Gemini: 50 MB / 1,000 pages via the Files API, 20 MB inline; 258 tokens per page.
 */
export function nativePdfPolicy(npm: string | null, contextTokens: number | null = null): NativePdfPolicy {
  const base: NativePdfPolicy = {
    requestBytes: 32 * MIB,
    requestHeadroomBytes: 4 * MIB,
    maxPages: 100,
    maxRawBytes: 10 * MIB,
    contextShare: 0.35,
    tokensPerPage: 2_000,
  };
  if (npm === "@ai-sdk/google" || npm === "@ai-sdk/google-vertex") return { ...base, requestBytes: 20 * MIB, maxPages: 1000, tokensPerPage: 258 };
  if (npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/google-vertex/anthropic" || npm === "@ai-sdk/amazon-bedrock") {
    // Anthropic's own example: about 7,000 tokens for a 3-page PDF with text and page images.
    return { ...base, tokensPerPage: 2_300, maxPages: contextTokens !== null && contextTokens >= 1_000_000 ? 600 : 100 };
  }
  return base;
}

/** Bytes a binary occupies once base64-encoded into a request body. */
export function encodedSize(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

function contextTokensOf(model: Record<string, unknown>): number | null {
  const limit = isRecord(model.limit) ? model.limit : null;
  return limit && typeof limit.context === "number" && limit.context > 0 ? limit.context : null;
}

function providersOf(catalog: unknown): unknown[] {
  const payload = isRecord(catalog) && "data" in catalog && isRecord(catalog.data) ? catalog.data : catalog;
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.all)) return payload.all;
  if (Array.isArray(payload.providers)) return payload.providers;
  return [];
}

function modelEntry(provider: Record<string, unknown>, modelID: string): Record<string, unknown> | null {
  const models = provider.models;
  if (Array.isArray(models)) {
    const found = models.find((model) => isRecord(model) && model.id === modelID);
    return isRecord(found) ? found : null;
  }
  if (!isRecord(models)) return null;
  const byKey = models[modelID];
  if (isRecord(byKey)) return byKey;
  const byId = Object.values(models).find((model) => isRecord(model) && model.id === modelID);
  return isRecord(byId) ? byId : null;
}

function supportFromModel(provider: Record<string, unknown>, model: Record<string, unknown>): ModelInputSupport {
  const api = isRecord(model.api) ? model.api : null;
  const modelProvider = isRecord(model.provider) ? model.provider : null;
  const npm = stringOrNull(api?.npm) ?? stringOrNull(modelProvider?.npm) ?? stringOrNull(provider.npm);

  const contextTokens = contextTokensOf(model);
  const capabilities = isRecord(model.capabilities) ? model.capabilities : null;
  const input = capabilities && isRecord(capabilities.input) ? capabilities.input : null;
  if (input) return { pdf: input.pdf === true, image: input.image === true, known: true, npm, contextTokens };

  const modalities = isRecord(model.modalities) ? model.modalities : null;
  if (modalities && Array.isArray(modalities.input)) {
    return { pdf: modalities.input.includes("pdf"), image: modalities.input.includes("image"), known: true, npm, contextTokens };
  }

  const attachment = typeof model.attachment === "boolean" ? model.attachment : capabilities?.attachment === true;
  return { pdf: false, image: attachment, known: true, npm, contextTokens };
}

export function inputSupportFromCatalog(catalog: unknown, providerID: string, modelID: string): ModelInputSupport {
  for (const provider of providersOf(catalog)) {
    if (!isRecord(provider) || provider.id !== providerID) continue;
    const model = modelEntry(provider, modelID);
    if (model) return supportFromModel(provider, model);
  }
  return TEXT_ONLY;
}

export type InputSupportResolver = {
  resolve(providerID: string, modelID: string): Promise<ModelInputSupport>;
};

/**
 * Caches the provider catalog so the per-step transform stays cheap. A failed
 * catalog read yields text-only handling and is retried shortly after.
 */
export function createInputSupportResolver(listProviders: () => Promise<unknown>, now: () => number = Date.now): InputSupportResolver {
  let catalog: { value: unknown; expiresAt: number } | null = null;
  let loading: Promise<unknown> | null = null;

  async function currentCatalog(): Promise<unknown> {
    if (catalog && catalog.expiresAt > now()) return catalog.value;
    if (!loading) {
      loading = listProviders()
        .then((value) => {
          catalog = { value, expiresAt: now() + CATALOG_TTL_MS };
          return value;
        })
        .catch(() => {
          catalog = { value: null, expiresAt: now() + CATALOG_FAILURE_TTL_MS };
          return null;
        })
        .finally(() => {
          loading = null;
        });
    }
    return loading;
  }

  return {
    async resolve(providerID, modelID) {
      return inputSupportFromCatalog(await currentCatalog(), providerID, modelID);
    },
  };
}
