export function gatewayGroupAssignmentsComplete(input: {
  linkedModelIds: Iterable<string>;
  catalogModelsById: ReadonlyMap<string, { model_id: string }>;
  allowedModelIds: readonly string[];
  representedModelIds: ReadonlySet<string>;
  hasTarget: boolean;
}): boolean {
  for (const id of input.linkedModelIds) {
    const model = input.catalogModelsById.get(id);
    if (!model) return false;
    if (input.allowedModelIds.length && !input.allowedModelIds.includes(model.model_id)) continue;
    if (!input.hasTarget || !input.representedModelIds.has(id)) return false;
  }
  return true;
}
