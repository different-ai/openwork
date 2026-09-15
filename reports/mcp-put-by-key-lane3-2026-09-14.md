# Lane3 — released post-deploy job, two-run convergence and usability

Date: 2026-09-14. **Final audit rerun, recording revision 2.** The fail-closed script was actually executed twice at 16:31 UTC after its bytes changed. Both complete apply invocations exited 0; all seven convergent mutations in run 2 returned 200, and the independently fetched resource counts and IDs were identical. `jobInvocations` now records actual argv, UTC start/end, exit, resolved curl/jq paths and script SHA-256 captured at execution (also checked afterwards), rather than an export-time source hash alone. This rerun replaces the previous Lane3 artifact SHA-256 `7c341e0250954711616dbf24afede97d6d95f8ce6782a5064950c0aab466e63e`; the superseded artifact is archived privately. Destructive lifecycle and negative/protocol controls remain separate. Formal testkit verification/publication remains pending the orchestrator; no testkit Passed verdict or product fix is claimed.

## Three requested verdicts

| Question | Executed result | Boundary |
| --- | --- | --- |
| Does real provider usability exist and work? | **YES.** Published `GET /v1/llm-providers/{id}/connect` returned the stored shared credential, privately verified against the configured value. The job fed that returned credential into published `POST /v1/llm-providers/test-connection`. Both runs authenticated against the enforcing synthetic endpoint, listed its model, and completed an actual completion request. Both API responses had `result.ok:true` and model verification `status:ok`. | This is Den's published connect/test operation, not a claim about a worker inference session or a separate Gateway data-plane route. Live OpenAPI searches for provider management, model/testing, and completion/inference operations found this supported test path, not an advertised chat-completion gateway endpoint. The test operation requests `max_tokens:16`; the synthetic completion actually returned **one output token**. It does not expose a request field to select a one-token maximum. |
| Is omitted OAuth `clientSecret` preserved? | **YES for the tested unchanged identity.** Run 1 supplied a pre-registered confidential-client secret; run 2 omitted it. Before the subsequent first connection, GET still reported `connected:false`, so there was no earlier access token to reuse. A fresh authorization-code + PKCE exchange after run 2 supplied the original client-secret fingerprint to the enforcing synthetic token endpoint and returned 200; the MCP tool then returned `authenticated:true`. A missing-client-secret control returned 401. | Tests this same client ID, URL, shared mode, issuer, scopes and access set only. It does not establish preservation after identity/client-ID changes or behavior against an unrelated OAuth provider. GET `oauthClientConfigured` alone was not used as proof. |
| Does pre-existing unkeyed GET/PUT preserve ID? | **YES.** Exactly one POST created the unkeyed fixture before the jobs. Each job GET the existing ID and PUT that same ID with its current `expectedUpdatedAt`; both updates returned 200 and retained `externalKey:null`. A stale timestamp control later returned 409, followed by a GET showing the successful state unchanged. | No key adoption or name-based reconciliation was attempted. The stale control is not counted as a successful convergent mutation. |

The missing-provider-credential negative returned an HTTP **200 diagnostic envelope** with `result.ok:false`, upstream `status:401`, and a credential-rejection hint. The configured path returned successful model/completion results instead. This directly exercises the credential-present versus credential-missing gate; a 200 envelope by itself is not treated as usability success.

## Release, isolation, and authentication

- Reused the **original** `mcp-put-proof-release` Compose project, retained private environment, retained synthetic owner organization and original owner API key. API port 18788 / web port 13005. No new user session was used or minted for Lane3.
- Ran `packaging/docker/docker-compose.eval.yml` unchanged. SHA-256: `7b94efe1ac4be68d56b8ecb91206e9c005360b0f7954ba36c6f6ae7bd87a9430`.
- Inspected running API: `ghcr.io/different-ai/openwork-den-api@sha256:e254a3842e7ecb6d0c7128b5f17201e92ac4ee566ad82c70c468938a3faa6407`; labels version **0.18.46**, revision `a0d6bd1de8debf4f09d22b8538e124b2ff45b339`.
- Executed linux/arm64 image/config ID `sha256:ab7f9107365c3f8befaf67e6f8f90d159a05fc066172af81ba581c9b7f5b6b11`; arm64 manifest `sha256:2d5a74dd8e7855ef542b4ed87096b18e1258a5f65579421321aa85967b396bb7`.
- Every Den proof request used curl with `x-api-key`, including the normal signed-state OAuth callback; no cookie or bearer-session headers. Public synthetic OAuth consent and its missing-secret negative control were called without sending the Den key upstream. No database seeding, role injection, authentication bypass, source-built API, product runtime patch, or `/v1/sso` request occurred.
- Only new Lane3 files were written. Prior lane fixtures, specs and reports were not modified during Lane3. No staging, commits, PRs or stash operations. Orchestrator owns commits and final testkit reruns.
- Prior transcripts remained byte-identical: original 51 receipts SHA-256 `c5f6ca7feb2abf0ec2229630cb78f981dec0b0fe5ee06e5998a21fd6d131f6bc`; tenant 37 receipts SHA-256 `8df72de0df9edc56606aa0f72e5d40f448ea26afd726da503327787682d7ca0e`.

## Actual job and contract compatibility

Executable script: `examples/declarative-org/rs-post-deploy-job.sh`. It is Bash + **curl/jq only** for the job, with secret references supplied through environment variables and owner-only private output. It disables shell tracing, never prints secret bodies, and does not automatically retry uncertain writes. The producer now fails nonzero immediately on curl failure or any unexpected HTTP status, with an explicit expected status recorded per request. Only literal GET `/v1/members` and `/v1/teams` may expect diagnostic 404. Provider connect requires a nonempty stored credential; usability requires `result.ok:true`, upstream status 200 and exactly the requested model verified as `ok`. Lifecycle requires delete 200/`deleted:true`, recreate 201 with a different nonempty ID, and matching verification GET; cleanup requires each expected HTTP 200 and `ok:true`. Separate Python helpers only prepare private environment, orchestrate the runs/controls, provide the synthetic server, and sanitize evidence.

The live release OpenAPI was fetched before implementation and at the beginning of **both jobs**. Every fetch returned 200; the keyed MCP PUT route was present. **`info.version` was `dev`**, and the job logged that actual value. The inspected image digest/labels, not that generic OpenAPI version string, establish the release.

The user-described literal envelopes/field placement are not the release's write shapes:

| Resource | Actual request used from the live contract | Incompatible literal assumption |
| --- | --- | --- |
| LLM provider | Top-level `name`, `source:"custom"`, `credentialMode:"shared"`, `apiKey`, `allMembers`, `memberIds`, `teamIds`, and `customConfig` containing provider ID/name/npm/env/api plus complete `models`. | `llmProvider` is a response envelope. There is no advertised top-level `mode` field; custom source selection is `source`. Model definitions belong in `customConfig.models`; assignments are the top-level access fields, not an `access` wrapper. |
| Organization | Exactly `PATCH /v1/org` with `{requireSso:false}` twice. | No SSO configuration endpoint or unrelated organization field was written. |
| Member/team resolution | Literal `GET /v1/members` and `GET /v1/teams` each returned **404**. `GET /v1/org` returned the actual members and teams. The job resolved exactly one synthetic owner by email, then PUT full `name`, `memberIds`, `grantsOrganizationAdmin:false`. | Standalone members/teams list paths are absent from this release's OpenAPI. `team` is the response envelope, not the write body. The organization-list substitution is explicit, not silently reported as success on those missing endpoints. |
| Keyed OAuth MCP | Top-level full `access` with team IDs; `oauthClient:{clientId,clientSecret,tokenEndpointAuthMethod}`; top-level `authorizationServerIssuer` and `requestedScopes`. Run 2 omitted only `oauthClient.clientSecret`. | `tokenAuthMethod` is not the advertised name. Issuer/scopes are not nested inside `oauthClient`. |
| Desktop policy | `policyName`, `policy:{access:{mode,capabilities},execution:{commands,blockedCommands,browserOrigins,blockBrowserUploads}}`, explicit priority/enabled/member/team/role assignments. | `desktopPolicy` is a response envelope, not the request body. |
| Marketplace | Top-level `name`, `description`, `logoUrl`. | `item` is a response envelope. |

The incompatible envelopes were identified from the **live request contracts**, not submitted as malformed writes. No fabricated 400 result is claimed for them. The missing list paths were actually requested, and their 404 receipts are retained as diagnostic exceptions.

## Two complete runs and stable-state comparison

The unkeyed fixture's one-time POST completed with **200 before either job**. Then the whole job ran twice consecutively, with no lifecycle deletion or OAuth consent between them.

| Convergent mutation | Run 1 | Run 2 |
| --- | --- | --- |
| Keyed custom LLM provider PUT | **201** | **200** |
| Restricted organization PATCH | **200** | **200** |
| Keyed team PUT with resolved member | **201** | **200** |
| Existing unkeyed MCP ID PUT | **200** | **200** |
| Keyed OAuth MCP PUT | **201** | **200**, client secret omitted |
| Keyed explicit desktop-policy PUT | **201** | **200** |
| Keyed marketplace PUT | **201** | **200** |

Both jobs exited **0**. Each run's OpenAPI, provider connect/test, organization/member fallback, unkeyed GET and actual snapshot GET operations returned **200**. Literal members/teams diagnostic GETs returned **404** in each run. Those diagnostics, POST usability tests, later stale control, OAuth protocol, and destructive lifecycle are not included in the seven-mutation all-200 claim.

Fresh GETs after each run produced sorted, independently comparable count/ID snapshots:

| Resource list | After run 1 | After run 2 | Exact sorted IDs equal? | After Lane3 cleanup |
| --- | ---: | ---: | --- | ---: |
| LLM providers | 1 | 1 | **Yes** | 0 |
| Teams from GET organization | 1 | 1 | **Yes** | 0 |
| MCP connections | 2 | 2 | **Yes** | 0 |
| Desktop policies | 2 | 2 | **Yes** | 1 pre-existing default |
| Marketplaces | 3 | 3 | **Yes** | 2 pre-existing built-ins |

Both complete snapshots, including all returned IDs, are in the transcript's `comparison` object and can be independently reconstructed from the raw GET receipts. This proves count/ID convergence, not byte-identical timestamps or internal assignment/model-row identities.

## Controls and explicit destructive exception

After the stable comparison returned `countsAndIdsIdentical:true` and `run2ConvergentAll200:true`:

1. Unkeyed GET **200**, stale ID PUT **409** (`connection_conflict`), verification GET **200** with the same successful ID/name/timestamp.
2. Missing provider credential: API diagnostic **200**, body `ok:false`, upstream **401**. Two configured test calls had already produced authenticated model-list requests and completion **200** responses with one output token each; actual outbound request budget was 16.
3. OAuth GET before first connection **200**, `connected:false`; connect/start **200**; synthetic consent **302**; normal callback **200**; GET **200**, now connected; authenticated tool call **200** with nonce `after-client-secret-omission`.
4. The synthetic token endpoint observed a successful confidential-client authorization-code/PKCE exchange with the original client-secret fingerprint. A later missing-secret request returned **401** `invalid_client`.
5. Marketplace GET **200**, keyed DELETE **200**, keyed PUT recreation **201**, verification GET **200**. Recreation returned a **new marketplace ID**. This lifecycle happened only after run 2's snapshot/comparison; it is intentionally destructive and cannot satisfy an all-200/no-new-ID convergence promise.

The synthetic OAuth fixture checks client ID/secret, redirect URI and PKCE. Its test consent is auto-granted only for the self-owned synthetic client and loopback callback on port 18788; no real user/provider account consent was impersonated. There was no earlier OAuth access token, so successful post-omission authentication demonstrates retained client credentials rather than access-token continuity.

## Artifacts, privacy and verification

New Lane3 files only:

- `examples/declarative-org/rs-post-deploy-job.sh` — executable job; SHA-256 `747d64f4ae6b70c64e5c79429efc2d933687c0da12066044609abf6492814158`.
- `evals/fixtures/mcp-post-deploy-release.py` — private-state orchestration, live-contract discovery, controls, comparison and redaction.
- `evals/fixtures/mcp-post-deploy-witness.py` — enforcing synthetic OpenAI-compatible/OAuth/MCP server.
- `reports/mcp-put-by-key-job-transcript-2026-09-14.json` — revision 2: **71 complete client request/response receipts**, **27 sanitized upstream witness receipts**, exactly **two actual applies in `jobInvocations`**, three separate setup/lifecycle/cleanup invocation receipts, image/job provenance, pre-redaction credential checks and full stable snapshots. All three full OpenAPI responses are retained. Final sanitized SHA-256: `8a3f1df51be19ab43eebfbfb17b4cc8acfd069f5c6eb296b380ee8e3487c1196`.
- `reports/mcp-put-by-key-recipe-headers-transcript-2026-09-14.json` — separate **five-receipt** exact-recipe rerun with actual proxy-observed request headers. SHA-256: `8c8c9214b47778d69823e6cd504e02b9e9fc9ad344586b60aa2110f25831d5f0`. The historical 51-receipt artifact was not modified or backfilled.
- `evals/specs/mcp-post-deploy-released-transcript.test.ts` — new recorded-release assertions, no changes to prior specs and no current-source server boot.
- This report.

Credential fields, API/session/token headers, signed OAuth state/code and actual secret values are redacted before publication. The released OpenAPI itself contained a personal-email example in schema prose; that example was additionally redacted in the new Lane3 transcript and the exporter now redacts non-example email addresses. **Documentation exposure noted for the orchestrator; no product/source-history edit was made.** Synthetic `example.com` identities remain. Private originals and secrets stay outside git. Management/connect credential material was never printed in the conversation.

Executed checks:

- `bash -n examples/declarative-org/rs-post-deploy-job.sh` and executable-bit check: completed.
- Python compilation for both Lane3 fixtures: completed; cache stored outside git.
- Focused dependency lint for the new spec: **no violations**, 5 modules / 4 dependencies.
- `pnpm --dir evals typecheck`: **2 errors in 451 files**, both outside Lane3: `evals/packages/env/test/app-web-runtime.test.ts:64` (TS2339, `OPENWORK_TOKEN`) and `evals/specs/session-attention-rollup.test.ts:27` (TS2345). No Lane3 error. Script reports lifecycle exit 1.
- `pnpm --dir evals lint:layers`: **54 violations outside the new spec**, script reports lifecycle exit 54. No clean control was permitted outside the lane, so these are unresolved/out-of-scope, not labeled pre-existing.
- jq receipt inspection independently confirmed the two stable snapshots, all seven run-2 mutation statuses, configured credential checks, two authenticated completions, the fresh OAuth secret fingerprint, unkeyed ID preservation and marketplace new-ID exception.
- Testkit was **not run**; final run/publication belongs to the orchestrator: `pnpm --dir evals test:pr specs/mcp-post-deploy-released-transcript.test.ts`.

## Final invocation receipts and fail-closed checks

Both actual applies used `bash examples/declarative-org/rs-post-deploy-job.sh apply <run>` and the same script SHA-256 `747d64f4ae6b70c64e5c79429efc2d933687c0da12066044609abf6492814158`. Before/after hashes matched for all five real invocations. The wrapper recorded the installed real executables `/run/current-system/sw/bin/curl` and `/run/current-system/sw/bin/jq`, not the isolated failure fixture.

| Actual arguments after script path | Started UTC | Ended UTC | Exit |
| --- | --- | --- | ---: |
| `apply run1` | `2026-09-14T16:31:20.637384+00:00` | `2026-09-14T16:31:22.060646+00:00` | **0** |
| `apply run2` | `2026-09-14T16:31:22.092983+00:00` | `2026-09-14T16:31:23.187047+00:00` | **0** |

Nine isolated producer failure checks executed the identical script bytes with a private test curl fixture, not against the release API. They verify early exits, not release behavior: transport failure **28** after one request; preflight HTTP failure **22** after one; non-allowlisted diagnostic HTTP failure **22** after three; usability `ok:false` and failed model verification **1** after four each; lifecycle `deleted:false` **1** after two; unexpected recreate status **22** after three; unchanged recreated ID **1** after three; cleanup HTTP failure **22** after one. Every check stopped before later steps. These fixture-based controls are deliberately excluded from the two actual apply receipts.

The shared `mcp_proof_redaction.py`, its six-sentinel test file, and the existing integrity-input assertions were not changed or reverted. New recording assertions cover invocation receipt completeness and the observed-header supplement. Broad ratchet/typecheck reruns were not repeated for this final audit, per the user's instruction; the earlier known failures remain the orchestrator's responsibility. Targeted validation of the updated recording spec reported **0 owned-file TypeScript diagnostics** (not a whole-repository typecheck), and focused dependency lint reported **0 violations**. Shell/Python syntax, recorded-data consistency and immutable-hash checks also completed; final testkit execution remains delegated.

## Exact recipe header-observation rerun

The previous historical recipe receipt header objects were constructed from intended headers, **not independent incoming-header observations**. They remain historical, unchanged; no new observation was fabricated into them. The new supplement explicitly records `historicalHeadersBackfilled:false` and links the unchanged original SHA-256.

The TLS proxy now captures the actual incoming header map privately. The recipe recorder consumes that map instead of assigning a hardcoded header object; it checks the received key against the configured key before sanitization. Both exact three-line RCA recipe executions were newly performed through trusted local TLS:

- First: start `2026-09-14T16:33:16.542916+00:00`, end `2026-09-14T16:33:17.059658+00:00`; **201**, pipeline exit **0**.
- Second: **200**, pipeline exit **0**, same new recipe resource ID. Full execution timestamps and literal recipe lines are in the supplement.
- Both observed maps contained Host `localhost:18443`, User-Agent `curl/8.21.0`, Accept `*/*`, x-api-key, Content-Type `application/json`, and Content-Length `222`. The key is redacted in the public artifact; `observedKeyMatchesConfigured:true` records its private comparison. **No Authorization or Cookie header was observed.**
- The untrusted TLS control exited **60** before an HTTP request was received. Actual recipe calls trusted the generated CA through `CURL_CA_BUNDLE`, with no insecure option. Recipe script SHA-256 remained `e1481d2a832917df94b944eefc94172f5ff852a2251450cff267600829e704f7` and matched the RCA's three lines.
- Recipe keyed cleanup returned **200** with deletion confirmed; final manageable connection list returned **200** and `[]`. The TLS proxy was stopped afterwards.

Private final-run directories are `$TMPDIR/opencode/mcp-post-deploy-final` and `$TMPDIR/opencode/mcp-recipe-headers-final`. The superseded Lane3 artifact is retained only in the former as `superseded-lane3-transcript.json`; the original 51 and tenant 37 public transcripts remain byte-identical. The recipe supplement is separate from the new Lane3 job revision, so their invocation/response counts cannot be conflated.

## Reproduction

Use the assigned worktree and a **new private output directory**. Reuse the original release environment and retained API-key state, not a DB seed. Do not overwrite prior output or run `prepare` twice for the same proof; it creates the single unkeyed fixture. Environment/state paths below must point to the owner's retained private directories.

```bash
set -euo pipefail
umask 077
export PROOF_PRIVATE_DIR="${TMPDIR%/}/opencode/mcp-post-deploy-repro"
export PROOF_RETAINED_DIR="${TMPDIR%/}/opencode/mcp-put-proof-release"
mkdir -p "$PROOF_PRIVATE_DIR"
docker compose -p mcp-put-proof-release --env-file "$PROOF_RETAINED_DIR/release.env" -f packaging/docker/docker-compose.eval.yml up -d --wait
python3 evals/fixtures/mcp-post-deploy-release.py prepare
python3 evals/fixtures/mcp-post-deploy-release.py discover
python3 evals/fixtures/mcp-post-deploy-release.py baseline
python3 evals/fixtures/mcp-post-deploy-release.py witness-env
docker run -d --name mcp-post-deploy-release-witness --label com.docker.compose.project=mcp-put-proof-release --network mcp-put-proof-release_default --env-file "$PROOF_PRIVATE_DIR/witness.env" -v "$PWD/evals/fixtures/mcp-post-deploy-witness.py:/witness.py:ro" python:latest python /witness.py
docker run -d --name mcp-post-deploy-release-tunnel --label com.docker.compose.project=mcp-put-proof-release --network mcp-put-proof-release_default cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://mcp-post-deploy-release-witness:8080
docker logs mcp-post-deploy-release-tunnel > "$PROOF_PRIVATE_DIR/tunnel.log" 2>&1
```

Export `STUB_URL` as the actual HTTPS quick-tunnel origin in that private log, then run:

```bash
python3 evals/fixtures/mcp-post-deploy-release.py run prepare
python3 evals/fixtures/mcp-post-deploy-release.py run apply run1
python3 evals/fixtures/mcp-post-deploy-release.py run apply run2
python3 evals/fixtures/mcp-post-deploy-release.py compare
python3 evals/fixtures/mcp-post-deploy-release.py controls
python3 evals/fixtures/mcp-post-deploy-release.py run lifecycle
python3 evals/fixtures/mcp-post-deploy-release.py negative-oauth
python3 evals/fixtures/mcp-post-deploy-release.py run cleanup
docker logs mcp-post-deploy-release-witness > "$PROOF_PRIVATE_DIR/witness.jsonl" 2>&1
python3 evals/fixtures/mcp-post-deploy-release.py export reports/mcp-put-by-key-job-transcript-new-run.json
docker rm -f mcp-post-deploy-release-tunnel mcp-post-deploy-release-witness
docker compose -p mcp-put-proof-release --env-file "$PROOF_RETAINED_DIR/release.env" -f packaging/docker/docker-compose.eval.yml down
```

The helper invokes the exact executable Bash job with private `DEN_API_KEY`, provider/OAuth credentials and member-selection environment. Operators can invoke the Bash job directly with those environment variables; no Python participates in the job's API requests. Export before stopping the API so actual container provenance can be inspected. Tunnel/DNS availability, installed curl/jq/Bash/Python/OpenSSL tooling and the retained valid owner key are prerequisites. This is an evaluation proof, not a production-ready OAuth provider or transactional deployment controller.

## Cleanup actually completed

All six Lane3-managed resources were API-deleted: provider, team, unkeyed MCP, keyed OAuth MCP, policy and recreated marketplace. Final GET lists show 0 providers, 0 teams, 0 MCPs; the pre-existing default policy and two built-in marketplaces remain with their original IDs. The requested `requireSso:false` organization setting remains; no SSO configuration route was touched.

The Lane3 witness/tunnel containers were removed; original release Compose `down` completed without `-v`, restoring the initially stopped state and preserving the original retained database/key environment. No Lane3 proof listener or original release container remains. Lane2 MySQL 13316 / Redis 16386 were left running untouched. Preliminary private material remains under `$TMPDIR/opencode/mcp-post-deploy-proof`; final rerun material is under `$TMPDIR/opencode/mcp-post-deploy-final`, and fresh recipe header observations/TLS material are under `$TMPDIR/opencode/mcp-recipe-headers-final`. The original owner key was neither rotated nor revoked. Shared pulled images remain cached. No global CA trust was modified. `reports/` is gitignored; the orchestrator must deliberately include the sanitized report/transcript if publishing.
