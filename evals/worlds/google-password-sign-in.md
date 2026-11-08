# Google sign-in against an isolated OAuth world

`google-password-sign-in.ts` composes `@openwork/labs/oauth`, disposable MySQL/Redis-backed Den, and headless Chrome. It seeds two fictional password accounts, not Google account or session rows. A person then uses the real email-first UI and Better Auth's built-in Google adapter, callback, token exchange, account linking and session creation.

## Run

From the repository root (Node 24, pnpm, Bun, Docker and headless Chrome):

```sh
pnpm install --frozen-lockfile
pnpm dev:den:mysql
pnpm evals:e2e google-password-sign-in --local
pnpm evals:e2e password-social-sign-in --local
pnpm --dir evals exec vitest run --project pr packages/labs/src/oauth/provider.test.ts
```

The world requires its own local Den; it rejects attached servers. Test data and browser profiles are disposable. Screenshots and assertion records are saved under `evals/results/test-runs/`, never committed.

## Boundaries

- `oauth-fetch-preload.ts` is loaded only in this world's child processes through `NODE_OPTIONS`. It routes exact built-in Google SDK token/JWKS/userinfo/discovery URLs to the loopback provider, preserving method, body and headers. Other Google URLs fail closed. Den's source and provider configuration are unchanged; issuer/audience/signature/expiry validation are not disabled.
- `oauth-browser.ts` intercepts the browser's real Google authorization request using CDP, records its state/PKCE witness, and redirects it to the same provider's local chooser. Consent pages and callback redirects are served over HTTP, not injected into the DOM. Unexpected Google browser requests fail closed.
- The fixture deliberately differs from live Google in its loopback address, synthetic accounts, no real password/MFA, no TLS, and deterministic fault controls. It is not a test of Google's live service, Google branding requirements, or production OAuth credentials.
- Better Auth 1.7.7's authorization-code callback decodes Google's ID token for the profile; it does not invoke its separate ID-token verifier or call discovery, JWKS or userinfo in this flow. This proof therefore claims token exchange and account linking, not signature verification by Den. The fixture's JWKS, signing/claims, discovery and userinfo are independently covered by protocol tests. This existing dependency behavior is not changed by this UI fix.

## Reproduce a regression

Copy only the test fixture/world/proof files into a clean worktree of the target base, leaving all product source untouched. Run the same `google-password-sign-in` proof. Its first step captures the password screen before looking for Google, so a missing button retains the issue's screenshot and fails the next step. The same proof on the fix must pass chooser → denied consent (no session/link) → retry → consent → token exchange → original user session. It also verifies the other seeded identity remains unchanged.

New providers should compose the protocol fixture with provider-specific endpoint/issuer configuration and transport routes. Do not extend production auth with test-only endpoint variables. Non-OIDC providers such as GitHub will need their own token/profile dialect on top of the same lifecycle/witness pattern; the generic OIDC configuration alone does not claim GitHub compatibility.
