export type BaseUrlEnv = Record<string, string | undefined>;

export function normalizeBaseUrl(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\/+$/, "");
}

export function joinBaseUrl(base: string | null | undefined, path: string): string {
  const normalizedBase = normalizeBaseUrl(base);
  const normalizedPath = path.trim().replace(/^\/+/, "");
  return normalizedPath ? `${normalizedBase}/${normalizedPath}` : normalizedBase;
}

export function readBaseUrlEnv(env: BaseUrlEnv, key: string): string | null {
  const normalized = normalizeBaseUrl(env[key]);
  return normalized ? normalized : null;
}

export function hostLabel(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    // Match existing UI fallback: remove a display-only http(s) prefix and trailing slashes.
    return normalizeBaseUrl(value).replace(/^https?:\/\//, "");
  }
}
