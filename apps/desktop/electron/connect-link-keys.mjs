// Trusted Ed25519 public keys for verifying connect links
// (openwork://connect?token=<JWT>), keyed by the token's `kid` header.
//
// These are VERIFICATION keys only — safe to publish. The matching private
// keys are held by the deployment operator that mints connect links (for
// OpenWork Cloud: the vendor's secret store) and never enter this repository.
// Rotation: generate a fresh pair with scripts/generate-connect-link-keypair.mjs,
// add the new public key here under its kid, ship a release, flip the minting
// side to the new kid, then drop the old entry in a later release.
//
// `owc-dev-2026-07` is the evaluation key used by the demo/eval flows while
// this feature is dark. Before enabling connect links for production, the
// vendor mints a production keypair (kid `owc-<yyyy-mm>`) and replaces it.

export const VENDOR_CONNECT_LINK_PUBLIC_KEYS = Object.freeze({
  "owc-dev-2026-07": `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA9XFgVZM5y/kpwpsrTWy1glrB2sw+XiUjyntDPrxTTt8=
-----END PUBLIC KEY-----`,
});

/**
 * The key map the running app trusts. Packaged builds use exactly the
 * embedded vendor keys. Dev mode (OPENWORK_DEV_MODE=1) may add ONE ephemeral
 * test key from the environment so evals and local e2e can mint their own
 * tokens without weakening packaged builds.
 *
 * @returns {Record<string, string>}
 */
export function resolveConnectLinkPublicKeys() {
  const keys = { ...VENDOR_CONNECT_LINK_PUBLIC_KEYS };
  if (process.env.OPENWORK_DEV_MODE === "1") {
    const testPem = process.env.OPENWORK_CONNECT_TEST_PUBLIC_KEY_PEM?.trim();
    const testKid = process.env.OPENWORK_CONNECT_TEST_PUBLIC_KEY_KID?.trim();
    if (testPem && testKid) {
      keys[testKid] = testPem;
    }
  }
  return keys;
}
