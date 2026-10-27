/**
 * Whether every effective linked assignment can be represented by the public
 * usable/auth-required aliases. A universe-policy exclusion is deliberate; a
 * missing catalog row, invalid model config, or omitted credential target is
 * not evidence that the assignment was removed.
 */
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
