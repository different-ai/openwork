/** Legacy references are app history identities, never native engine IDs. */
export function isLegacyThread(id: unknown): id is string {
  return typeof id === "string" && /^v1:[a-f0-9]{24}:ses_[A-Za-z0-9]+$/.test(id);
}

export function legacyHistoryBase(opencodeBaseUrl: string): string {
  if (!/\/opencode2\/?$/.test(opencodeBaseUrl)) throw new Error("Legacy history requires an OpenWork v2 workspace endpoint.");
  return opencodeBaseUrl.replace(/\/opencode2\/?$/, "/legacy-history");
}
