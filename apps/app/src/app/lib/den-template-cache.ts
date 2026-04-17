import { createDenClient, type DenTemplate } from "./den";

type DenTemplateCacheKeyInput = {
  baseUrl?: string | null;
  token?: string | null;
  orgSlug?: string | null;
};

type DenTemplateCacheEntry = {
  templates: DenTemplate[];
  busy: boolean;
  error: string | null;
  loadedAt: number | null;
  promise: Promise<DenTemplate[]> | null;
};

const templateCache = new Map<string, DenTemplateCacheEntry>();

function getCacheKey(input: DenTemplateCacheKeyInput): string | null {
  const baseUrl = input.baseUrl?.trim() ?? "";
  const token = input.token?.trim() ?? "";
  const orgSlug = input.orgSlug?.trim() ?? "";
  if (!baseUrl || !token || !orgSlug) return null;
  return `${baseUrl}::${orgSlug}::${token}`;
}

function readEntry(key: string | null): DenTemplateCacheEntry {
  if (!key) {
    return {
      templates: [],
      busy: false,
      error: null,
      loadedAt: null,
      promise: null,
    };
  }

  return (
    templateCache.get(key) ?? {
      templates: [],
      busy: false,
      error: null,
      loadedAt: null,
      promise: null,
    }
  );
}

function writeEntry(key: string, next: DenTemplateCacheEntry) {
  templateCache.set(key, next);
}

function toMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

export function readDenTemplateCacheSnapshot(input: DenTemplateCacheKeyInput) {
  const key = getCacheKey(input);
  const entry = readEntry(key);
  return {
    key,
    templates: entry.templates,
    busy: entry.busy,
    error: entry.error,
    loadedAt: entry.loadedAt,
  };
}

export async function loadDenTemplateCache(
  input: DenTemplateCacheKeyInput,
  options: { force?: boolean } = {},
): Promise<DenTemplate[]> {
  const key = getCacheKey(input);
  if (!key) return [];

  const current = readEntry(key);
  if (current.promise) {
    return current.promise;
  }
  if (!options.force && current.loadedAt && !current.error) {
    return current.templates;
  }

  const request = createDenClient({
    baseUrl: input.baseUrl?.trim() ?? "",
    token: input.token?.trim() ?? "",
  })
    .listTemplates(input.orgSlug?.trim() ?? "")
    .then((templates) => {
      writeEntry(key, {
        templates,
        busy: false,
        error: null,
        loadedAt: Date.now(),
        promise: null,
      });
      return templates;
    })
    .catch((error) => {
      const latest = readEntry(key);
      writeEntry(key, {
        templates: latest.templates,
        busy: false,
        error: toMessage(error, "Failed to load team templates."),
        loadedAt: latest.loadedAt,
        promise: null,
      });
      throw error;
    });

  writeEntry(key, {
    templates: current.templates,
    busy: true,
    error: null,
    loadedAt: current.loadedAt,
    promise: request,
  });

  return request;
}

export function clearDenTemplateCache() {
  if (templateCache.size === 0) return;
  templateCache.clear();
}
