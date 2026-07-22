#!/usr/bin/env node
// Generates a dedicated Ed25519 keypair for signing connect links
// (openwork://connect?token=<JWT>).
//
//   node scripts/generate-connect-link-keypair.mjs [kid]
//
// The PRIVATE key belongs in the deployment operator's secret store only
// (env DEN_CONNECT_LINK_PRIVATE_KEY, alongside DEN_CONNECT_LINK_KEY_ID) —
// never in this repository. The PUBLIC key is safe to publish and is what
// desktop builds embed (apps/desktop/electron/connect-link-keys.mjs).

import { generateKeyPairSync } from "node:crypto"

const now = new Date()
const defaultKid = `owc-${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
const kid = process.argv[2]?.trim() || defaultKid

if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid)) {
  console.error(`Invalid kid "${kid}" — use 1-64 chars of [A-Za-z0-9._-].`)
  process.exit(1)
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
})

console.log(`# Connect-link signing keypair (kid: ${kid})`)
console.log("#")
console.log("# 1. Store the PRIVATE key in the deployment's secret store, e.g.:")
console.log(`#      DEN_CONNECT_LINK_KEY_ID=${kid}`)
console.log("#      DEN_CONNECT_LINK_PRIVATE_KEY=<private PEM below>")
console.log("#    (Infisical / Render dashboard / Helm secret.values.connectLinkPrivateKey)")
console.log("# 2. Add the PUBLIC key to VENDOR_CONNECT_LINK_PUBLIC_KEYS in")
console.log("#    apps/desktop/electron/connect-link-keys.mjs under this kid.")
console.log("# 3. Never commit the private key.")
console.log()
console.log("== PRIVATE KEY (secret) ==")
console.log(privateKey.trimEnd())
console.log()
console.log("== PUBLIC KEY (embed in desktop build) ==")
console.log(publicKey.trimEnd())
