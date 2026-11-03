/** A catalog model as Den returns it: the models.dev record is in `config`. */
export type GatewayCatalogModel = { id: string; name: string; config: Record<string, unknown> };

/** models.dev release dates are YYYY-MM-DD or YYYY-MM; anything else sorts last. */
function releaseDate(model: GatewayCatalogModel): string {
  const value = model.config.release_date;
  return typeof value === "string" && /^\d{4}-\d{2}(-\d{2})?$/.test(value) ? value : "";
}

/** Newest release first; models released the same day, or without a date, keep name order. */
export function sortModelsNewestFirst<T extends GatewayCatalogModel>(models: readonly T[]): T[] {
  return [...models].sort((left, right) => releaseDate(right).localeCompare(releaseDate(left)) || left.name.localeCompare(right.name));
}

/** A text model that can answer the test prompt: not deprecated, and not an image, video or embedding model. */
export function canAnswerTestPrompt(model: GatewayCatalogModel): boolean {
  const type = model.config.type;
  return model.config.status !== "deprecated" && (type === undefined || type === "chat" || type === "text");
}

/**
 * The model a provider test uses: the first one, in the order the list shows,
 * that can answer a text prompt. With "Only the ones I pick" only picked models count.
 * Falls back to the first candidate when none qualifies, so the test still runs.
 */
export function pickTestModel(models: readonly GatewayCatalogModel[], picked: readonly string[] | null): string | null {
  const candidates = picked === null ? models : models.filter((model) => picked.includes(model.id));
  return (candidates.find(canAnswerTestPrompt) ?? candidates[0])?.id ?? null;
}
