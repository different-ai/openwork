export const LOCAL_PREFERENCES_KEY = "openwork.preferences";

export type LinkOpenDestination = "openwork" | "external";

export function isLinkOpenDestination(value: unknown): value is LinkOpenDestination {
  return value === "openwork" || value === "external";
}

export function readLinkOpenDestination(): LinkOpenDestination {
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(LOCAL_PREFERENCES_KEY) ?? "null");
    return stored && typeof stored === "object" && Reflect.get(stored, "linkOpenDestination") === "external"
      ? "external"
      : "openwork";
  } catch {
    return "openwork";
  }
}
