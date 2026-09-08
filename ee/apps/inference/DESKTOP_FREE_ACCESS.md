# Desktop Free Luna

Disabled by default. No deployment, key setup, provider calls, or live migration
is part of this change. This is a follow-up above #4629, not a replacement of its
member-free accounting. Anonymous identity, request validation, reservation,
settlement, configuration, route hook and tables are bounded reuse from #4621
at `401267fc3a5e8c32f49f990fd9e054455347ef1f`. The reference is untouched.

## Native Contract

`@openwork/types/desktop-free-access` is the browser-safe shared contract. It has
only constants, types, a type-only catalog import, and `desktopFreeProofMessage`.
The native process owns the Ed25519 private key and installed app version, not
the renderer. There is no embedded shared app secret.

Every request has `x-openwork-desktop-proof`: base64url JSON of
`{version:1,publicKey,appVersion,platform,arch,timestamp,nonce,signature}`.
`publicKey` is canonical base64 SPKI DER; `signature` is base64url Ed25519.
The signature input is UTF-8 JSON of the ordered array
`[1,methodUpper,path,bodyHash,authorizationHash,publicKey,appVersion,platform,arch,timestamp,nonce]`.
`path` includes pathname plus search, never origin. Both hashes are lowercase
SHA-256 hex. Hash **raw body bytes**, not parsed or reserialized JSON; use empty
bytes on GET. Hash the actual Authorization header string including `Bearer `,
or empty when absent at session issuance. Query overrides are still rejected.
`platform` is `darwin|win32|linux`, `arch` is `arm64|x64`, `timestamp` is Unix
milliseconds within +/-60 seconds, and `nonce` is a fresh UUID each request.
The encoded header is capped at 2048 ASCII bytes; unknown fields are rejected.

Registration is `POST /api/anonymous/session` with `{installationId:<UUID>}`.
Response is `{token,expiresAt,model}` (`expiresAt` in Unix milliseconds).
The UUID remains required for request compatibility, but is not quota identity.
Installation accounting is the server HMAC of the **verified Ed25519 public-key
thumbprint**. Changing only `installationId` with the same key cannot reset the
weekly allowance, installation rate limits, or installation concurrency limit.
Encrypted `ow_guest_v2.` credentials bind IP, installation, key thumbprint,
declared app version, platform, and arch. Token verification also checks that its
installation accounting identity matches its bound key. Unbound v1 credentials
and inconsistent identities are rejected.
Use `Authorization: Bearer <guest>` for the anonymous status, models and chat
routes. Re-register after an upgrade, token expiry, or IP change. Keep the native
signing key persistent across login/logout; the frontend uses this same anonymous
route before and after login, never adds the member-free balance to it.

The existing member-free gateway also requires that proof plus
`x-openwork-desktop-token: <guest>`; its Authorization stays the **member** Bearer
and the signature binds that string. Member-free discovery and generation both
apply the gate. Paid keys never enter this gate, and paid/BYOK accounting and
member-free usage/reservation/settlement are unchanged. The new desktop headers
are redacted from inference reports and never forwarded to providers.

SQL consumes key-thumbprint/nonce identities uniquely across routes/replicas
before issuance/reservation. Nonces expire just after timestamp +61 seconds;
the acceptance window is checked again under the SQL lock. Cleanup is bounded
to 1000 expired rows per consume, and 50,000 stored nonces closes admission
rather than permitting unlimited self-signed registration storage.

This is **desktop deterrence, not official-binary attestation**. Self-signed
registration proves key possession, not who built the caller. A modified native
client can lie about its version or generate a new key to reset its identity.
Changing a UUID alone no longer helps, but key reset and cross-account abuse
remain possible; IP/global caps and disabled rollout are
backstops. The member and installation ledgers are not merged: native routing
avoids ordinary double allowance, but this is not adversarial deduplication of
a person across both ledgers.

## Version And Status

The server-configured `DESKTOP_FREE_APP_VERSION_URL` now defaults to the official
publication pointer used for latest stable releases:
`https://api.github.com/repos/different-ai/openwork/releases/latest`.
The default accepts only a release payload with a stable semver `tag_name`
(an optional leading `v` is removed), `draft:false`, `prerelease:false`, and a
valid `published_at` timestamp. Missing fields, zero/dev tags and prerelease tags
fail closed. It never falls back to Den or a committed local version if GitHub
fails, and a Den-shaped body at the default URL is rejected.

HTTPS only, no credentials in URL, no redirects, three-second timeout, a 256 KiB
response cap (GitHub includes asset lists), and at most five minutes of gateway
cache from fetch start. GitHub is read without a token, with a product User-Agent.
Availability depends on GitHub and its public API rate limits, including traffic
from other replicas sharing an egress IP. After the fresh gateway cache expires,
network failures, malformed releases, rate limiting or any non-success response
mean `desktop_version_unavailable`, not a false update prompt. There is no
stale-cache fallback or automatic source failover. Observations reflect the
publication pointer served by GitHub plus this bounded cache, not a promise of
instant worldwide release propagation. A new floor does not require a gateway
deployment to be observed.

An explicitly configured **non-default** URL may still return Den's
`latestAppVersion` (NOT `minAppVersion`) as a trusted **operator policy floor**.
Den may return committed fallback data with a fresh HTTP response; accepting
that configured authority does not guarantee freshly verified GitHub state.
Release-shaped custom responses must still pass the release checks and cannot
downgrade to a Den field after failing them. There is no inferred freshness marker
or claim that the gateway cache validates the custom source's own freshness.
Native callers read only the gateway's floor; client-provided floor/latest-version
values are never accepted.

Strict semver comparison requires at least the stable metadata version.
`1.2.3-alpha < 1.2.3`; `1.2.4-alpha >= 1.2.3`. Build suffixes do not affect
precedence. Missing/invalid/`0.0.0` client versions fail closed; an invalid,
missing, zero, or prerelease server floor means unavailable, not update required.
The floor is checked on every issuance/status/models/generation request before
reservation or upstream dispatch, including previously issued bound tokens.

Blocked issuance/models/generation respond with 426 and
`{error:{code:'desktop_update_required',currentVersion,minimumVersion,message}}`.
Unavailable metadata responds with 503 and the same envelope with
`code:'desktop_version_unavailable'` and `minimumVersion:null`.

Signed `GET /api/anonymous/status` returns `DesktopFreeAccessStatus` as JSON:

```ts
{
  state: 'ready' | 'update_required' | 'unavailable' | 'exhausted',
  code: string | null,
  currentVersion: string,
  minimumVersion: string | null,
  providerID: 'openwork-free',
  modelID: 'openai/gpt-5.6-luna',
  allowance: { limitUsd, usedUsd, reservedUsd, remainingUsd, resetsAt } | null,
  catalog?: ManagedModelRecommendation[]
}
```

Status is HTTP 200 for those authenticated states, never cached, never generates,
and never creates a spend/rate bucket or reservation. Authentication/replay
failures remain 401; proof-store failures are 503. The only status write is nonce
consumption/TTL cleanup. `catalog` exposes the shared
`managedModelCatalog({freeModelID: 'openai/gpt-5.6-luna'})` as **discovery only**,
including Astra and other paid recommendations. The guest picker may show these
as read-only Upgrade rows; they are not connected model configurations, free
entitlements, or an implicit routing fallback. Without real paid credentials,
clients must not select or execute them. Anonymous `/v1/models` and chat execution
remain Luna-only. Metadata blocks omit the allowance.

**UI must label allowance values as estimates.** `usedUsd` includes retained
unknown usage. `reservedUsd` is active safety holds, not billed usage.
`remainingUsd` excludes holds. `exhausted` with
`anonymous_reservation_does_not_fit` can mean positive balance below the hold;
do not claim all $1 was spent. Status is an observation, not a reservation;
concurrent requests, rate/concurrency limits and shared caps can still block.

## Accounting And Limits

The anonymous route retains #4621's conservative admission, rather than adopting
the member ledger's final-request capped-overage policy. Each request must fit
its entire worst-case hold in every spend bucket. Trusted BYOK principal plus
OpenRouter fee settles actual usage and refunds the difference. Unknown usage
retains the hold; cap/token overruns trip the durable anonymous kill switch.
No request is dispatched without reservation. A full dollar of actual usage is
**not guaranteed**: the final hold can fail to fit. This is a deliberate bounded
reuse choice; member accounting is not changed.

| Setting (all anonymous spend is micro-USD) | Default |
| --- | --- |
| `ANONYMOUS_INFERENCE_ENABLED` | `false` |
| `ANONYMOUS_INSTALL_WEEKLY_MICRO_USD` | 1,000,000 ($1), resets Monday 00:00 UTC |
| `ANONYMOUS_IP_DAILY_MICRO_USD` | 5,000,000 ($5) |
| `ANONYMOUS_GLOBAL_DAILY_MICRO_USD` | 100,000,000 ($100) |
| `ANONYMOUS_GLOBAL_MONTHLY_MICRO_USD` | 3,000,000,000 ($3,000) |
| `ANONYMOUS_GLOBAL_INFLIGHT` | 20; one per installation |
| Session issuance per hour: installation / IP / global | 12 / 60 / 10,000 |
| Generation requests per hour: installation / IP / global | 60 / 300 / 10,000 |
| `ANONYMOUS_TOKEN_TTL_SECONDS` | 3600 |
| `ANONYMOUS_MAX_BODY_BYTES` | 262,144 |
| `ANONYMOUS_MAX_INPUT_TOKENS` | 131,072 |
| `ANONYMOUS_CHAT_WRAPPING_TOKEN_ALLOWANCE` | 2048 |
| `ANONYMOUS_MAX_COMPLETION_TOKENS` | 4096 |
| Input / output micro-USD per million tokens | 250,000 / 1,200,000 |
| Request timeout / response cap | 60 seconds / 2 MiB |
| `ANONYMOUS_TRUST_PROXY_HOPS` | 0 (socket IP only) |

All configurable counts/caps require finite positive bounded integers (proxy
hops may be zero); no zero-means-unlimited spend. No installation daily/monthly
cap remains. The default maximum hold is $0.041452, including a fixed 10% fee
and accounting margin. Shared caps are safety limits, not promised entitlement.
IPv6 clients aggregate to /64. Forwarded IPs are trusted only after canonical
exact checks of every configured hop against `ANONYMOUS_TRUSTED_PROXY_IPS`.

Activation requires a **separate** `ANONYMOUS_OPENROUTER_API_KEY`, an explicit
`ANONYMOUS_OPENROUTER_PROVIDER`, and
`ANONYMOUS_OPENROUTER_BYOK_ONLY_VERIFIED=true` as an operator assertion after
configuring that OpenRouter key BYOK-only. This change does not set up or test
that account. Also provide two distinct >=32-character server secrets:
`ANONYMOUS_TOKEN_SECRET` (token encryption) and
`ANONYMOUS_ACCOUNTING_IDENTITY_KEY` (stable HMAC accounting identities). Never
rotate the latter as a token refresh: that resets accounting identities. Native
clients receive neither key. Free routing pins provider and Luna, disables
fallbacks, remote media and provider/server tools, and applies price/token caps.

## Migration And Checks

`0094_anonymous_inference.sql` appends only anonymous definitions and the new
nonce table above the current `0093_free_inference_allowance.sql`. Do not copy
the reference's `0094_snapshot.json`: its parent is a different 0093 and lacks
this branch's member-free tables. No existing ledger or billing SQL is replaced.
The snapshot was generated offline with Drizzle from this branch's current 0093
snapshot. Its parent identity and unchanged member-free tables were verified;
no database migration was executed.

Focused offline tests are in `test/desktop-free-access.test.ts` and the existing
`test/proxy.test.ts`. They use ephemeral keys, mocked metadata/provider/SQL
boundaries and in-memory Hono requests. They do not establish live SQL concurrency
or installed-desktop journey proof. E2E, provider calls, migration execution,
and build campaigns are deliberately deferred by request.

Checks after dependency preparation: **98 focused tests passed**, zero failed
or skipped, in about 1.2 seconds on the first run; the post-type-fix rerun also
passed. This includes same-key/different-UUID registration accounting, the full
discovery catalog with Luna-only execution, and mocked GitHub release shapes,
cache expiry, rate limits, and custom Den authority. The targeted inference type
check passes after correcting Buffer/typed-array conversions in the proof
verifier. Syntax and `git diff --check` also pass. Commands (each bounded to 30
seconds; no real external calls):

```sh
SENTRY_DSN= NODE_OPTIONS=--conditions=development pnpm --filter @openwork-ee/inference exec tsx --test test/desktop-free-access.test.ts test/proxy.test.ts
pnpm --filter @openwork-ee/inference exec tsc --noEmit -p tsconfig.json --rootDir ../../..
```

Live SQL concurrency and installed-desktop E2E remain **Incomplete/deferred**.
No live migration or release metadata request was performed.

The generated 0094 snapshot retains all 100 prior tables and adds exactly the
five anonymous tables plus the nonce table. Its 12 DDL statements match the
migration after whitespace/case normalization; the control-row INSERT and journal
entry are preserved. Future regeneration must retain the current 0093 parent,
not substitute the reference branch's unrelated snapshot.
