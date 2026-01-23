type RawEvent = {
  type?: string;
  properties?: unknown;
  payload?: { type?: string; properties?: unknown };
};

export type NormalizedEvent = {
  type: string;
  properties?: any;
};

export function normalizeEvent(raw: RawEvent | null | undefined): NormalizedEvent | null {
  if (!raw) return null;
  if (typeof raw.type === "string") {
    return { type: raw.type, properties: raw.properties };
  }
  if (raw.payload && typeof raw.payload.type === "string") {
    return { type: raw.payload.type, properties: raw.payload.properties };
  }
  return null;
}
