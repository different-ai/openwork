/**
 * Which coworker models the app chose by itself this session. A model the
 * person picked is never swapped behind their back; one the app picked may be
 * replaced automatically when it turns out not to work.
 */
const autoPicked = new Map<string, string>();

export function markAutoPicked(slug: string, modelId: string): void {
  autoPicked.set(slug, modelId);
}

export function wasAutoPicked(slug: string, modelId: string): boolean {
  return Boolean(modelId) && autoPicked.get(slug) === modelId;
}

/** Forget the automatic choice once the person picks a model themselves. */
export function clearAutoPicked(slug: string): void {
  autoPicked.delete(slug);
}
