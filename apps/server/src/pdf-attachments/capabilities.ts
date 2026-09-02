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
};

export type NativePdfLimits = {
  maxBytes: number;
  maxPages: number;
};

const MIB = 1024 * 1024;
const CATALOG_TTL_MS = 5 * 60_000;
const CATALOG_FAILURE_TTL_MS = 30_000;

export const TEXT_ONLY: ModelInputSupport = { pdf: false, image: false, known: false, npm: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Provider request limits for a PDF sent as-is. Conservative defaults keep a
 * document that would be rejected upstream on the derived path instead.
 */
export function nativePdfLimits(npm: string | null): NativePdfLimits {
  if (npm === "@ai-sdk/google" || npm === "@ai-sdk/google-vertex") return { maxBytes: 20 * MIB, maxPages: 1000 };
  return { maxBytes: 30 * MIB, maxPages: 100 };
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

  const capabilities = isRecord(model.capabilities) ? model.capabilities : null;
  const input = capabilities && isRecord(capabilities.input) ? capabilities.input : null;
  if (input) return { pdf: input.pdf === true, image: input.image === true, known: true, npm };

  const modalities = isRecord(model.modalities) ? model.modalities : null;
  if (modalities && Array.isArray(modalities.input)) {
    return { pdf: modalities.input.includes("pdf"), image: modalities.input.includes("image"), known: true, npm };
  }

  const attachment = typeof model.attachment === "boolean" ? model.attachment : capabilities?.attachment === true;
  return { pdf: false, image: attachment, known: true, npm };
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
