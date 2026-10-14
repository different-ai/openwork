# Frozen pre-removal Electron connect-link implementation

`connect-link.mjs` is copied **verbatim** from
`02bfb7f65:apps/desktop/electron/connect-link.mjs` (the pre-removal `origin/dev`
merge base). SHA-256:

```
da7091a1ccafaf4c433d674044779c711710c308764ff42ae6d31c93575d4b98
```

Keep this fixture frozen; do not update it to match current schemas. The regression
uses its actual signature verification, claim validation (including mandatory
`brand`), expiry, HTTPS policy, exchange issuer binding and persistent replay
guard. It runs as a Node module, not as a packaged Electron/native OS smoke test.

The world seeds synthetic dormant organization data directly into its own
scratch database because the retired branding mutation route must not be
available. All observed handoffs and ordinary organization edits use the real
Den HTTP routes. Additional negative wire vectors are deliberately signed with
`node:crypto` to bypass the new signer's stock-brand normalization.
