/** The build embeds these generated modules in standalone runner bundles. */
declare module "*/dist/desktop-identity.mjs" {
  /** The image and guest identities (each with its trailing newline) and the guest bundle's SHA-256. */
  const identity: { image: string; guest: string; bundleSha256: string }
  export default identity
}
declare module "*/dist/desktop-guest-bundle.mjs" {
  /** The guest bundle, gzipped and base64-encoded. */
  const bundle: string
  export default bundle
}
