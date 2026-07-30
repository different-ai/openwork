export const LAST_DESKTOP_HANDOFF_GRANT_STORAGE_KEY = "openwork.den.lastHandoffGrant";

const LAST_DESKTOP_HANDOFF_GRANT_MAX_AGE_MS = 15 * 60 * 1000;

type StoredDesktopHandoffGrant = {
  grant: string;
  at: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function getDesktopGrant(url: string | null): string | null {
  if (!url) return null;

  try {
    const grant = new URL(url).searchParams.get("grant")?.trim() ?? "";
    return grant || null;
  } catch {
    return null;
  }
}

export function getDesktopHandoffOpenworkUrl(payload: unknown): string | null {
  if (!isRecord(payload)) {
    return null;
  }

  const openworkUrl = payload.openworkUrl;
  return typeof openworkUrl === "string" && openworkUrl.trim() ? openworkUrl.trim() : null;
}

export function getDesktopHandoffGrant(payload: unknown, openworkUrl: string | null): string | null {
  if (isRecord(payload) && typeof payload.grant === "string" && payload.grant.trim()) {
    return payload.grant.trim();
  }

  return getDesktopGrant(openworkUrl);
}

export function rememberDesktopHandoffGrant(grant: string | null) {
  const trimmed = grant?.trim() ?? "";
  if (!trimmed || typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(
    LAST_DESKTOP_HANDOFF_GRANT_STORAGE_KEY,
    JSON.stringify({ grant: trimmed, at: Date.now() }),
  );
}

function parseStoredDesktopHandoffGrant(value: string | null): StoredDesktopHandoffGrant | null {
  if (!value) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || typeof parsed.grant !== "string" || typeof parsed.at !== "number") {
    return null;
  }

  const grant = parsed.grant.trim();
  if (!grant) {
    return null;
  }

  return { grant, at: parsed.at };
}

export function readLastDesktopHandoffGrant(maxAgeMs = LAST_DESKTOP_HANDOFF_GRANT_MAX_AGE_MS): string | null {
  if (typeof window === "undefined") {
    return null;
  }

  const stored = parseStoredDesktopHandoffGrant(window.localStorage.getItem(LAST_DESKTOP_HANDOFF_GRANT_STORAGE_KEY));
  if (!stored || Date.now() - stored.at > maxAgeMs) {
    return null;
  }

  return stored.grant;
}
