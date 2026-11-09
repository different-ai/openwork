/**
 * Files that must be revalidated on every load (`Cache-Control: no-cache`): the page itself and the web app manifest.
 * Hashed files under /assets are immutable instead; everything else keeps the default.
 */
export function isRevalidatedFile(path: string) {
  return /\.(?:html|webmanifest)$/.test(path)
}
