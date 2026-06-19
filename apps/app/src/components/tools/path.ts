export function parseFilename(filePath: string | undefined) {
  if (!filePath) {
    return "file"
  }
  return filePath.replace(/\\/g, "/").split("/").pop() ?? filePath
}

export function truncateText(value: string, max: number) {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value
}

export function toolDisplayTitle(
  title: string | null,
  detail?: string
): string | undefined {
  if (!title) {
    return undefined
  }
  if (!detail) {
    return title
  }
  return `${title} ${detail}`
}
