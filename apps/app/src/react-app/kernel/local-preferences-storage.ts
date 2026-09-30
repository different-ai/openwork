export const LOCAL_PREFERENCES_KEY = "openwork.preferences";

export type LinkOpenDestination = "openwork" | "external";

export function isLinkOpenDestination(value: unknown): value is LinkOpenDestination {
  return value === "openwork" || value === "external";
}
