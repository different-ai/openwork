export type SiteCategory = "ordinary" | "finance" | "email" | "identity";
export type CookieSameSite = "unspecified" | "no_restriction" | "lax" | "strict";
export type ImportBrowser = "chrome" | "edge" | "brave" | "chromium" | "firefox" | "safari";

/** A cookie in the shape every reader produces and every writer consumes. */
export type NormalizedCookie = {
  /** Host as stored by the browser; a leading dot marks a domain cookie. */
  host: string;
  hostOnly: boolean;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: CookieSameSite;
  /** Unix seconds, or null for a session cookie. */
  expiresAt: number | null;
  /** Unix seconds, when the source browser records it. */
  lastAccessedAt: number | null;
};

/** A site the user can choose to stay signed in to. Never carries cookie values. */
export type ImportableSite = {
  site: string;
  hosts: string[];
  cookieCount: number;
  sessionCookieCount: number;
  lastUsedAt: number | null;
  category: SiteCategory;
  preselected: boolean;
  reason: string | null;
};

export type ElectronCookieDetails = {
  url: string;
  name: string;
  value: string;
  domain?: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: CookieSameSite;
  expirationDate?: number;
};

export type ElectronCookieLike = {
  name?: string;
  value?: string;
  domain?: string;
  hostOnly?: boolean;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
  expirationDate?: number;
};

export type ImportSourceAvailability = {
  browser: ImportBrowser;
  label: string;
  importable: boolean;
  reason: string | null;
};

export const BUILTIN_BROWSER_PARTITION: "persist:openwork-browser";
export const SITE_CATEGORIES: readonly SiteCategory[];
export const SENSITIVE_CATEGORIES: readonly SiteCategory[];

export function registrableDomain(host: string): string;
export function classifySite(site: string): SiteCategory;
export function isSensitiveCategory(category: string): boolean;
export function categoryReason(category: SiteCategory): string | null;
export function looksLikeSessionCookie(cookie: Pick<NormalizedCookie, "httpOnly" | "name">): boolean;
export function groupCookiesIntoSites(cookies: NormalizedCookie[], options?: { now?: number }): ImportableSite[];
export function cookiesForSites(cookies: NormalizedCookie[], sites: string[]): NormalizedCookie[];
export function toElectronCookie(cookie: NormalizedCookie): ElectronCookieDetails;
export function fromElectronCookie(cookie: ElectronCookieLike): NormalizedCookie;
export function importSourceAvailability(platform: NodeJS.Platform | string): ImportSourceAvailability[];
