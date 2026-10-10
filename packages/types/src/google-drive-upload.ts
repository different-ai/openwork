/** Google supports files up to 5 TiB. File bytes must never be tool arguments. */
export const GOOGLE_DRIVE_UPLOAD_MAX_BYTES = 5 * 1024 ** 4
export const GOOGLE_DRIVE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024

/** A session URL is a bearer credential, not an arbitrary upload destination. */
export function isGoogleDriveUploadSessionUrl(value: string, apiBase = "https://www.googleapis.com"): boolean {
  try {
    const url = new URL(value)
    const base = new URL(apiBase)
    return url.origin === base.origin
      && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      && !url.username && !url.password && !url.hash
      && url.pathname === "/upload/drive/v3/files"
      && url.searchParams.get("uploadType") === "resumable"
      && Boolean(url.searchParams.get("upload_id"))
  } catch {
    return false
  }
}
