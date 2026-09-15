# Released MCP keyed PUT and post-deploy proof

Date: 2026-09-14. Source/harness base: `d203b574150c06a14b86443b1d8cb32c451a1b45`.
Branch: `test/mcp-connections-by-key-proof`; isolated worktree: `openwork-mcp-put-proof`.

## Executive answer

**Functional on released 0.18.46 for the executed scenarios: YES, 8/8 Lane1 cases verified. An unconditional “100% functional/safe for every unattended manifest” claim: NO.** Sequential API-key-only create/reapply/rename/access replacement, conflicts, secret retention, deletion/recreation, and tenant isolation worked. Omitting `access` **widens team-only access to organization-wide**. The job must use the actual released request contracts, preserve explicit access, and distinguish convergence from intentional delete/recreate. OAuth initial consent is not made unattended by provisioning a client secret; the proof used a self-owned synthetic consent server.

**Lane2 narrow live-dev result: Passed (1 test, eight case assertions, zero skips). Lane1/Lane3 recorded-receipt checks: Passed for the captured runtime observations, not new executions of the image. Overall PR integration: Incomplete; draft only.** The boundary ratchet rejects three new offline receipt/redaction specs in `evals/specs`; these need an approved location or real released-image test boundary before ready-for-review. No test-policy exemption, pretend boundary, or baseline expansion was added. The runtime findings below do not rely on source inventory.

## Image actually executed

- `ghcr.io/different-ai/openwork-den-api:0.18.46`
- Immutable index: `sha256:e254a3842e7ecb6d0c7128b5f17201e92ac4ee566ad82c70c468938a3faa6407`
- Platform tested: **linux/arm64**, manifest `sha256:2d5a74dd8e7855ef542b4ed87096b18e1258a5f65579421321aa85967b396bb7`
- Inspected OCI revision: `a0d6bd1de8debf4f09d22b8538e124b2ff45b339`
- Evaluation Compose SHA-256: `7b94efe1ac4be68d56b8ecb91206e9c005360b0f7954ba36c6f6ae7bd87a9430`; original Compose unchanged.
- Live `/openapi.json` reports **`info.version: "dev"`**. Route presence is verified, but release identity comes from running-container/image inspection, not this string.

Local Docker was explicitly requested and available. Lane1 and Lane3 ran the published image, not a source build. Tenant isolation used a second disposable stack with the **same pinned image** and a documented `multi_org` environment override; the unchanged evaluation stack is single-org and rejected second-org setup with 409. No database seeding or authentication bypass was used. Bootstrap alone used an administrator session; every acceptance request used `x-api-key` without browser/session cookies. Missing-key controls deliberately omitted it.

## Lane1 — per-step results

| Step / request | Expected | Released observation | Status |
| --- | --- | --- | --- |
| 1 PUT `/v1/mcp-connections/by-key/rs-proof-1`, no-auth HTTP MCP | 201, ID/key | 201, `emc_` ID, requested key; live validation completed | Passed |
| 2 identical PUT; manageable GET list | 200, same ID, no duplicate | 200, same ID/timestamp, exactly one matching row | Passed |
| 3 PUT renamed/scoped access; then omit access | 200, same ID; establish replace/merge | 200; team-only grants replaced; omission becomes `orgWide:true`, empty team/member arrays | Passed — widening confirmed |
| 4 POST same externalKey | 409 points to keyed PUT | 409 `external_key_exists`, existing ID and PUT path in message | Passed |
| 5 GET ID, PUT ID with current/stale `expectedUpdatedAt` | 200 then 409/412 | 200 then **409** `connection_conflict`; stale payload did not overwrite | Passed |
| 6 secret-bearing PUT/GET, omission PUT/GET, upstream calls | no echo; retained working secret | `authType:apikey` is upstream Bearer auth; no echo; two authenticated nonce-bearing tool calls 200 with same fingerprint, missing-token control 401 | Passed |
| 7 DELETE keyed; GET old ID; PUT same key | 200/204, 404, 201/new ID | **200, 404, 201**, new ID | Passed |
| 8 missing/invalid key; foreign-key ID operations; spoofed org header | reject unauthorized access | No/invalid key **401**. Foreign ID GET/PUT/DELETE **404**, also with spoofed org header. Same slug legitimately creates its own org-local ID with 201; disjoint lists | Passed — 404 is actual tenant-safe result, not 401/403 |

**Access verdict:** replacement, not merge/preservation. Always send the full intended `access` object. Dev additionally demonstrated a non-team member's tools access changing from 403 to 200 after omission.

**Secret verdict:** no echo in tested MCP PUT/GET responses; omitted Bearer credential preserved with unchanged identity. Do not generalize to URL/auth/client-ID changes, custom-header maps, OAuth grant transfer, or all provider connect endpoints. The LLM provider `/connect` endpoint deliberately returns its authorized credential to the caller; it is separately redacted.

**Exact RCA three-line HTTPS recipe:** ran verbatim twice, **201 then 200**, same ID, exits 0. Local TLS proxy trusted via `CURL_CA_BUNDLE`; untrusted control exited 60. A subsequent rerun captured actual incoming headers at the proxy (matching API key, no Authorization/Cookie), rather than assuming the recipe's headers. No insecure fallback.

## Lane3 — whole job twice

Executable: `examples/declarative-org/rs-post-deploy-job.sh` (Bash, curl, jq; no embedded secrets). Final fail-closed script was executed twice consecutively, with execution-time hashes, argv, timestamps and exits in `jobInvocations`. Both exits **0**; source SHA-256 `747d64f4ae6b70c64e5c79429efc2d933687c0da12066044609abf6492814158`.

| Mutation | Run 1 | Run 2 | Identity |
| --- | --- | --- | --- |
| Keyed OpenAI-compatible LLM provider | 201 | 200 | Same ID |
| PATCH org, exactly `{requireSso:false}` | 200 | 200 | Same org; no SSO endpoint writes |
| Keyed team with member resolved by email | 201 | 200 | Same ID |
| Pre-existing unkeyed MCP GET/PUT by ID | 200 | 200 | Same ID; key remains null |
| Keyed OAuth MCP, run 2 omits clientSecret | 201 | 200 | Same ID |
| Keyed policy, explicit access/execution blocks | 201 | 200 | Same ID |
| Keyed marketplace | 201 | 200 | Same ID before deliberate lifecycle |

Fresh list snapshots after both runs have identical counts and sorted IDs: **providers 1, teams 1, MCP connections 2, policies 2, marketplaces 3**. Default policy and two built-in marketplaces are included. This is count/ID convergence, not a guarantee of unchanged internal assignment rows or every timestamp.

After the stable comparison, the explicitly destructive marketplace check returned DELETE **200**, PUT **201**, **new ID**. This cannot be included in an all-200/no-new-ID promise. Literal missing-list diagnostics, negative controls and OAuth protocol are also labeled separately; no claim that every HTTP request in the transcript is 200.

### Three requested gates

1. **Provider usability check exists and works: YES.** `GET /v1/llm-providers/{id}/connect` supplies the stored credential; the job uses it in `POST /v1/llm-providers/test-connection`. Both configured runs authenticate at the synthetic model list/completion endpoint and return `result.ok:true` with successful model verification. The missing-credential control returns HTTP 200 **but `ok:false`, upstream 401**; the final script checks the body, not just HTTP status. The synthetic completion returns one output token; the operation's request budget is 16, not a caller-selected one-token maximum. This proves the published connect/test path, not a worker/Gateway inference session.
2. **OAuth clientSecret preserved on omission: YES for unchanged identity.** After run 2, before any prior OAuth connection existed, a fresh authorization-code/PKCE exchange authenticates with the original secret fingerprint; tool call 200. Missing-secret token control 401. GET flags alone were not treated as retention proof. Synthetic consent is not proof of unattended consent against a real provider.
3. **Unkeyed PUT-by-ID roundtrip: YES.** One POST beforehand, two GET/current-timestamp PUTs retain ID/null key; stale control **409** with no overwrite. No key adoption or delete/recreate workaround.

### Released contract corrections — material for operator scripts

- `llmProvider`, `team`, `desktopPolicy`, `item` are **response envelopes**, not the submitted write shapes. The tested script follows live OpenAPI; incompatible envelopes were not submitted and no fabricated 400 is claimed.
- Custom provider uses `source:"custom"`, `credentialMode`, `customConfig.models`, and top-level `allMembers/memberIds/teamIds`, not the proposed top-level mode/models/access envelope.
- Literal **GET `/v1/members` and `/v1/teams` each returned 404**; members/teams were explicitly resolved from GET `/v1/org` instead. Therefore the originally described literal job is not drop-in compatible.
- OAuth client uses `oauthClient.tokenEndpointAuthMethod`; issuer/scopes are top-level `authorizationServerIssuer` and `requestedScopes`.
- Policy writes use `policyName`, `policy.access`, `policy.execution`, explicit assignment fields; marketplace writes are top-level name/description/logoUrl.

## Undocumented setup and limits

Read the evaluation, declarative-configuration, and first-administrator guides under `packages/docs/self-host`. The configured private first-admin setup worked through its **undocumented headless underlying bootstrap/verify/signup APIs**; the documented browser `/setup` UI was not driven. Session-authenticated API-key issuance is also an explicit headless setup detail not given by those guides. Initial password constraint failures are retained and the reproduction now generates compliant passwords.

The unchanged release rejected an internal plain-HTTP MCP witness with 400 (“Hosted MCP connections must use HTTPS”). A self-owned synthetic MCP/OAuth/provider witness used an ephemeral public HTTPS tunnel; no Den key/session was sent to that tunnel. TLS, DNS and tunnel availability are reproduction prerequisites. All non-secret public evidence is sanitized; private originals, credentials, logs and certificates stay outside git. A personal-email schema example in released OpenAPI was redacted rather than republished; no customer identity belongs in this public report.

Not tested: amd64 runtime, concurrent first applies, arbitrary provider/OAuth implementations, changed OAuth identities, production deployment, encryption-at-rest, or real customer data. No source runtime changes or schema migrations were authored. Main checkout/other worktrees remained untouched; no stash or merge.

## Verification and PR boundary

Exact narrow commands, run locally with mise pnpm 11.4.0, Bun 1.4.0 and Node 24.20.0 on PATH, and `OPENWORK_EVAL_DAYTONA` / `OPENWORK_EVAL_DEN_API_URL` unset:

| Command | Exit | Passed / failed / skipped |
| --- | --- | --- |
| `pnpm evals:pr specs/mcp-connection-released-transcript.test.ts` | 0 | 10 / 0 / 0 |
| `pnpm evals:pr specs/mcp-post-deploy-released-transcript.test.ts` | 0 | 10 / 0 / 0 |
| `pnpm evals:pr specs/mcp-proof-redaction.test.ts` | 0 | 6 / 0 / 0 |
| `OPENWORK_EVAL_MYSQL_URL=mysql://root:lane2-fixture-password@127.0.0.1:13316 DATABASE_REDIS_URL=redis://127.0.0.1:16386 pnpm evals:pr specs/mcp-connection-by-key-api-key.test.ts` | 0 | 1 / 0 / 0, eight live case assertions |

The MySQL value above is a deliberately public disposable fixture credential, not an operator/API credential. Bring up its isolated services using `docker compose -p mcp-put-proof-dev -f evals/fixtures/mcp-put-proof.compose.yml up -d --wait`; build types/den-db/email and install root/evals frozen dependencies as documented in the test skills. Final-head runs and testkit evidence are published on the PR separately from this committed report.

**Blockers, not hidden:** `node evals/scripts/spec-boundary-ratchet.mjs` exits 1, including introduced offline specs `mcp-connection-released-transcript`, `mcp-post-deploy-released-transcript`, and `mcp-proof-redaction` (no live product boundary). Full typecheck exits 1 with two diagnostics in untouched `app-web-runtime.test.ts:64` and `session-attention-rollup.test.ts:27`; layer lint exits 54 with violations outside the new files; channel/boundary ratchets also flag other files. Without a clean control run these other failures are **unresolved**, not asserted pre-existing. Focused new-file dependency lint, shell syntax and Python compilation passed. Draft PR only: no broad green or ready-for-review claim.

## Evidence and cleanup

- `reports/mcp-put-by-key-transcript-2026-09-14.json`: original 51 released receipts.
- `reports/mcp-put-by-key-tenant-transcript-2026-09-14.json`: 37 supplemental same-image multi-org receipts.
- `reports/mcp-put-by-key-recipe-headers-transcript-2026-09-14.json`: 5 rerun receipts including observed proxy headers.
- `reports/mcp-put-by-key-job-transcript-2026-09-14.json`: final executed job, 71 client requests, 27 upstream receipts, actual invocation exits/hashes and snapshots. Full OpenAPI responses retained; this accounts for its size.
- Detailed setup/reproduction notes: `reports/mcp-put-by-key-lane1-2026-09-14.md` and `reports/mcp-put-by-key-lane3-2026-09-14.md`. Their handoff-time “pending orchestrator” notes are historical; this consolidated report and final-head PR evidence supersede that status.

Release test resources removed through APIs; original release stack/proxy/tunnel stopped. Supplemental tenant stack/volume removed and both keys revoked. Original release volume/key and private audit material retained locally, offline; original owner key not revoked. No global CA trust changes. Lane2 disposable database is removed by the test; supporting MySQL/Redis can be stopped with the project-specific Compose command. No production resources touched.

## What we can tell the customer with certainty

“We verified the released Den API 0.18.46 image—not just source—with API-key-only requests. The keyed MCP PUT created once, reapplied without duplication, updated the same ID, handled conflicts, preserved omitted credentials with unchanged identity, and respected organization isolation. A corrected full post-deploy job also converged on a second run; provider credential usability, OAuth client-secret retention and existing unkeyed MCP updates were exercised successfully. Always provide explicit access because omission resets it to organization-wide, use the released request shapes and `/v1/org` member/team lists, and treat intentional delete/recreate and real-provider OAuth consent separately. These observations do not certify an unobserved installation or every concurrent/provider-specific case.”
