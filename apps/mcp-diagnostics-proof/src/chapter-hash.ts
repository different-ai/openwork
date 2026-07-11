export function chapterIdFromHash(hash: string, validIds: readonly string[]) {
  try {
    const id = decodeURIComponent(hash.replace(/^#/, ""))
    return validIds.includes(id) ? id : null
  } catch {
    return null
  }
}
