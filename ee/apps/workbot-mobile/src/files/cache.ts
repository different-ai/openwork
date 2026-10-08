import { Directory, File, Paths } from "expo-file-system"

/**
 * Files opened, previewed or shared on this phone are downloaded into the app's cache, one copy per file version.
 * Signing out removes them.
 */
const root = () => new Directory(Paths.cache, "workbot-files")

export async function clearCachedFiles() {
  try {
    const directory = root()
    if (directory.exists) directory.delete()
  } catch {
    // Nothing cached, or already gone.
  }
}

/** A kept file on this phone (downloaded once per version), with the headers the download needs. */
export async function cachedFile(input: { url: string; headers: Record<string, string>; id: string; name: string; version?: number }): Promise<File> {
  const directory = root()
  if (!directory.exists) directory.create({ intermediates: true, idempotent: true })
  const safe = input.name.replace(/[^\w.\- ]+/g, "_").slice(-120) || "file"
  const target = new File(directory, `${input.id}-${input.version ?? 0}-${safe}`)
  if (target.exists) return target
  return File.downloadFileAsync(input.url, target, { headers: input.headers, idempotent: true })
}
