// Merges keyed contributor fragments. Two contributors writing the same key
// is a registration bug, so it throws (at boot for boot contributors).
export function mergeCoreHookRecords<V>(point: string, fragments: ReadonlyArray<Readonly<Record<string, V>>>): Record<string, V> {
  const merged: Record<string, V> = {}
  for (const fragment of fragments) {
    for (const [key, value] of Object.entries(fragment)) {
      if (Object.prototype.hasOwnProperty.call(merged, key)) {
        throw new Error(`core_hook_contribution_collision: ${point} key "${key}" is contributed twice`)
      }
      merged[key] = value
    }
  }
  return merged
}
