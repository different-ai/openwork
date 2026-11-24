export type GatewayCatalogModel = { id: string; name: string; config: Record<string, unknown> };

function releaseDate(model: GatewayCatalogModel): string {
  const value = model.config.release_date;
  return typeof value === "string" && /^\d{4}-\d{2}(-\d{2})?$/.test(value) ? value : "";
}

export function sortModelsNewestFirst<T extends GatewayCatalogModel>(models: readonly T[]): T[] {
  return [...models].sort((left, right) => releaseDate(right).localeCompare(releaseDate(left)) || left.name.localeCompare(right.name));
}

export function canAnswerTestPrompt(model: GatewayCatalogModel): boolean {
  const type = model.config.type;
  return model.config.status !== "deprecated" && (type === undefined || type === "chat" || type === "text");
}

export function pickTestModel(models: readonly GatewayCatalogModel[], picked: readonly string[] | null): string | null {
  const candidates = picked === null ? models : models.filter((model) => picked.includes(model.id));
  return (candidates.find(canAnswerTestPrompt) ?? candidates[0])?.id ?? null;
}
