export function denErrorReferenceId(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null || !("referenceId" in payload)) return undefined;
  return typeof payload.referenceId === "string" && payload.referenceId.length === 30 && /^req_[0-9a-hjkmnp-tv-z]{26}$/.test(payload.referenceId)
    ? payload.referenceId : undefined;
}
