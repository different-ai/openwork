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
  fallback: string,
  detail?: string
) {
  const primary = title ?? fallback
  if (!detail) {
    return primary
  }
  return `${primary} ${detail}`
}
