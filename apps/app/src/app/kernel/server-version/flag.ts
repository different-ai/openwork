function isTruthyFlag(value: string | null | undefined) {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

export function isServerV2Enabled() {
  const viteValue = typeof import.meta !== "undefined" && typeof import.meta.env?.VITE_OPENWORK_UI_USE_SERVER_V2 === "string"
    ? import.meta.env.VITE_OPENWORK_UI_USE_SERVER_V2
    : undefined;

  const rawValue = viteValue
    ?? (typeof process !== "undefined" && typeof process.env?.OPENWORK_UI_USE_SERVER_V2 === "string"
      ? process.env.OPENWORK_UI_USE_SERVER_V2
      : undefined);

  return isTruthyFlag(rawValue);
}
