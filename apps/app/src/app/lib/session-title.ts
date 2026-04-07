import { t } from "../../i18n";

/** Raw English string — used for prefix matching against stored titles. */
export const DEFAULT_SESSION_TITLE = "New session";

const GENERATED_SESSION_TITLE_PREFIX = `${DEFAULT_SESSION_TITLE} - `;

export function isGeneratedSessionTitle(title: string | null | undefined) {
  const trimmed = title?.trim() ?? "";
  if (!trimmed.startsWith(GENERATED_SESSION_TITLE_PREFIX)) return false;
  const suffix = trimmed.slice(GENERATED_SESSION_TITLE_PREFIX.length).trim();
  return Boolean(suffix) && Number.isFinite(Date.parse(suffix));
}

export function getDisplaySessionTitle(
  title: string | null | undefined,
  fallback?: string,
) {
  const trimmed = title?.trim() ?? "";
  if (!trimmed || isGeneratedSessionTitle(trimmed)) return fallback ?? t("session.default_title");
  return trimmed;
}
