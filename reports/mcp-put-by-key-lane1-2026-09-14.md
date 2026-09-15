# Lane1 — released MCP keyed PUT black-box receipts

Date: 2026-09-14. **Requested runtime coverage is complete:** cases 1–8 and the exact HTTPS recipe executed with expected results. The original single-org provisioning refusal was a configuration boundary, not a product authentication failure. After explicit scope expansion, an isolated supplemental multi-org stack running the identical pinned release verified the foreign-org case. Formal testkit verification remains **Incomplete/pending the orchestrator's narrow run**; broader static-check failures are noted below. The original 51-receipt transcript remains byte-identical.

## Isolation and release actually executed

- Only the designated `openwork-mcp-put-proof` worktree was written. Main RCA was read-only. No commits, PRs, stash, product fixes, database seeding, source-built Den, authentication bypass, or changes to Lane2 files/services.
- Worktree source base: `d203b574150c06a14b86443b1d8cb32c451a1b45`. This identifies the harness/docs context, **not** the running product.
- Docker server `6.1.0`, Compose `5.5.0`; unique project `mcp-put-proof-release`. API `127.0.0.1:18788`, web `127.0.0.1:13005`. MySQL had no published host port.
- `packaging/docker/docker-compose.eval.yml` stayed byte-for-byte unchanged: SHA-256 `7b94efe1ac4be68d56b8ecb91206e9c005360b0f7954ba36c6f6ae7bd87a9430`, matching the evaluation guide.
- Running API reference: `ghcr.io/different-ai/openwork-den-api@sha256:e254a3842e7ecb6d0c7128b5f17201e92ac4ee566ad82c70c468938a3faa6407`.
- Registry index inspection independently returned that same digest. Executed platform: **linux/arm64**, manifest digest `sha256:2d5a74dd8e7855ef542b4ed87096b18e1258a5f65579421321aa85967b396bb7`; local image/config ID `sha256:ab7f9107365c3f8befaf67e6f8f90d159a05fc066172af81ba581c9b7f5b6b11`.
- Inspected OCI labels: version `0.18.46`, revision `a0d6bd1de8debf4f09d22b8538e124b2ff45b339`. The web image also used the Compose-pinned release digest. An initial tag-only inspection failed because the image was stored by digest; inspection by the running container's image ID succeeded.

## Observed acceptance cases

All acceptance requests used plain curl with `x-api-key` and jq parsing; no session/cookie headers were supplied to them. Missing-key controls intentionally omitted the key. Ordinary evaluation traffic stayed on loopback HTTP; the exact recipe used verified HTTPS.

| Case | Actual HTTP statuses | Observed result |
| --- | --- | --- |
| 1. New keyed no-auth connection | PUT **201** | `externalKey=rs-proof-1`, nonempty `emc_` ID, connected public witness. |
| 2. Exact repeat and list | PUT **200**, GET list **200** | Byte-equivalent JSON request, same ID and timestamp; exactly **one** matching list entry. |
| 3. Rename/access replacement | Team PUT **201**; scoped PUT/GET **200/200**; omitted-access PUT/GET **200/200** | Connection ID unchanged. First access was `orgWide:false`, empty members, one team. Omitting `access` then returned `orgWide:true`, empty members/teams: **confirmed widening**, not preservation. |
| 4. POST duplicate key | POST **409** | `external_key_exists`; response names the existing ID and directs caller to `PUT /v1/mcp-connections/by-key/rs-proof-1`. |
| 5. GET + conditional ID update | GET **200**, PUT **200**, stale PUT **409**, verification GET **200** | Correct `expectedUpdatedAt` accepted; stale timestamp rejected with `connection_conflict`. Verification retained the successful rename/timestamp, not the stale payload. |
| 6. Secret creation/read/omission | Secret PUT **201**, GET **200**, tools/call **200**, omission PUT **200**, GET **200**, tools/call **200** | `authType:apikey` sends an upstream Bearer token. Raw PUT/GET responses were checked **before sanitization**: none contained the secret or an `apiKey` field. Same identity and ID retained after omission. Both real upstream calls returned `authenticated:true` and distinct requested nonces, with the same one-way token fingerprint at the enforcing witness. A no-token direct witness control returned **401**. |
| 7. Key deletion and recreation | DELETE **200**, old-ID GET **404**, PUT **201** | Deletion returned `{ok:true,deleted:true}`. Recreation returned the same external key with a **new** ID. |
| 8a. Missing-key rejection | PUT **401**, GET **401**, authenticated list **200** | No unauthorized resource was created. |
| 8b. Foreign-org ID isolation | Original single-org setup **409**; supplemental source PUT **201**, six foreign/spoofed ID operations **404**, same-key own-org PUT **201**, lists **200**, missing/invalid keys **401** | Supplemental legitimate multi-org deployment completed the case: different users/owner keys, source unchanged, different IDs for the same external key, disjoint lists even with a spoofed source-org header. See supplemental section. The original 409 is retained as configuration evidence, not treated as an auth failure. |

## Exact RCA recipe, executed verbatim

`evals/fixtures/mcp-put-release-recipe.sh` contains precisely RCA lines 144–146. The runner compared those three lines against the read-only RCA before executing them, including `set -euo pipefail`, the original jq body construction, and `curl --proto '=https' --fail-with-body ... | jq ...`.

- A separate loopback TLS proxy listened at `https://localhost:18443` and forwarded to the unchanged release API at port 18788. No product container or Compose environment was changed for TLS.
- A generated private CA signed the localhost certificate, including DNS `localhost` and IP `127.0.0.1` SANs. `openssl verify -CAfile ca.pem localhost.pem` returned OK.
- An untrusted curl control returned **curl exit 60 / HTTP 000**. The two actual recipe invocations trusted only this CA through `CURL_CA_BUNDLE`; no `--insecure`, global trust-store installation, or HTTP substitution.
- Exact recipe first apply: **201**, pipeline exit **0**. Second: **200**, pipeline exit **0**, same ID and key `platform-tools`. The first projected `reconnectionRequired` was null because the create response omits that property; the repeat returned false.
- The proxy captured the complete API response because the verbatim recipe intentionally projects only four fields. These captures and the actual jq outputs are in the standard transcript, under `recipe-first` and `recipe-second`.

## Operator setup, documentation gaps, and limitations

Read `packages/docs/self-host/evaluate-with-docker-compose.mdx`, `packages/docs/self-host/declarative-configuration.mdx`, and `packages/docs/self-host/deploy-to-your-cloud/first-administrator.mdx` before deployment.

1. The documented private first-admin operator configuration worked: signup disabled, synthetic owner email allowlisted, random setup code and encryption/authentication secrets. However, **the browser `/setup` UI was not driven**. The permitted integration alternative called its underlying bootstrap/status, bootstrap/verify, and Better Auth signup APIs using curl. This is an **undocumented headless bootstrap recipe**, not proof of the documented browser onboarding experience.
2. The real setup code yielded a grant; password signup created the first account and singleton organization; setup subsequently returned `complete`. An authenticated administrator GET `/v1/org` returned 200, and session-authenticated POST `/v1/api-keys` returned 201. The administrator session was used only for setup/API-key issuance and the attempted second-org setup. No database bootstrap shortcut was used. The declarative guide says an admin must issue a key but does not provide this concrete headless issuance sequence; route shapes were inspected only to drive setup, never as behavioral proof.
3. Two initial signup attempts failed safely with 400: `password_too_long` (maximum 32) and `password_missing_special_character`. The final compliant password succeeded with 200. Every attempt is retained with secret inputs redacted. These password constraints were not stated in the three operator guides.
4. Live MCP validation/SSRF restrictions apply. Attempting the internal HTTP witness URL returned **400**, including `Hosted MCP connections must use HTTPS.` The unchanged Compose file does not pass a private-MCP allowance. No SSRF override was introduced. A separate synthetic Python HTTP MCP witness on the project network was exposed through an ephemeral Cloudflare HTTPS tunnel, which passed normal release validation. No Den API key or admin session was sent to that tunnel; only the synthetic upstream bearer secret was used there.
5. The existing Lane2 TypeScript witness was read but not changed: it binds only loopback and lacks successful tools/call support. Lane1 uses a separate Python fixture with public/auth-required endpoints and real nonce-bearing tools/call results. Python/client plumbing invokes curl and jq; it does not use an HTTP SDK to make proof requests.
6. Tunnel availability and public DNS/TLS are external reproducibility dependencies. Helper images were auxiliary Python/cloudflared images, not part of the product under test. The proof does not certify other release versions, amd64, OAuth identity changes, concurrency, encryption-at-rest, tenant isolation beyond the exercised API routes, or a production deployment.
7. **Original constraint resolved by explicit user authorization:** the first single-org deployment could not provision a second org. The supplemental stack uses the supported `multi_org` mode with public signup, normal user signup, session-authenticated organization creation and key issuance. This is the user-authorized deployment configuration for case 8, not an authentication bypass or a database-seeding workaround.

## Artifacts and static checks

- Standard sanitized transcript: `reports/mcp-put-by-key-transcript-2026-09-14.json` — **51** complete labeled client request/response receipts, including setup errors, controls, acceptance traffic, exact recipe responses, and API cleanup. Also includes inspected image metadata, pre-redaction secret checks, and sanitized witness tools/call receipts. Container health probes are not acceptance/client requests and are not included.
- This report: `reports/mcp-put-by-key-lane1-2026-09-14.md`.
- New spec only: `evals/specs/mcp-connection-released-transcript.test.ts`. It imports `test` from `@openwork/testkit` and asserts both recorded release transcripts without booting current source. The explicit foreign-org skip was removed only after the supplemental runtime proof executed; assertions now cover distinct owner identities, foreign/spoofed GET/PUT/DELETE rejection, unchanged source, same-key disjoint resources, invalid/missing keys, and cleanup. It also verifies the original transcript's SHA-256.
- `pnpm --dir evals typecheck`: initial introduced predicate typing error corrected. Final output: **2 errors in 450 files**, neither in Lane1: `evals/packages/env/test/app-web-runtime.test.ts:64` (`OPENWORK_TOKEN`, TS2339), and `evals/specs/session-attention-rollup.test.ts:27` (`AttentionSession.time`, TS2345). Script reports lifecycle exit 1.
- `pnpm --dir evals lint:layers`: **54 violations**, script reports lifecycle exit 54. No Lane1 spec violation listed. Focused dependency-cruiser invocation after adding supplemental assertions: **no violations**, 5 modules / 4 dependencies.
- Broader failures are **unresolved/outside Lane1**, not called pre-existing: a clean control would require work outside the assigned scope. Those files were not edited.
- Python `py_compile` for all four new `.py` fixtures, `bash -n` for the three-line recipe, and `git diff --check` completed. Python bytecode was directed outside git; the incidental initial local cache was removed.
- The testkit spec has **not been run**; the user assigned the narrow run to the orchestrator. No published testkit evidence or PR is claimed. Orchestrator command: `pnpm --dir evals test:pr specs/mcp-connection-released-transcript.test.ts`.
- `reports/` is ignored by repository rules. The three authorized sanitized deliverables (two transcripts and this report) exist on disk; the orchestrator must deliberately include them if publishing. Nothing was staged.

## Reproduction

Run from the dedicated proof worktree. Install Docker/Compose, curl, jq, OpenSSL, Python 3.12+, and the repository's pnpm/Node toolchain for static/testkit checks. Do not reuse the private directory for a fresh run without archiving its prior receipts. Use a new private directory and an intentionally fresh evaluation database for first-admin bootstrap; the currently retained database is already initialized.

```bash
set -euo pipefail
export PROOF_PRIVATE_DIR="${TMPDIR%/}/opencode/mcp-put-proof-release"
umask 077
mkdir -p "$PROOF_PRIVATE_DIR"
test ! -e "$PROOF_PRIVATE_DIR/release.env"
printf 'OPENWORK_AUTH_SECRET=%s\nOPENWORK_DB_ENCRYPTION_KEY=%s\nOPENWORK_API_PORT=18788\nOPENWORK_WEB_PORT=13005\nOPENWORK_ORG_NAME=Release Proof\nOPENWORK_ALLOW_SIGNUP=false\nOPENWORK_OWNER_EMAILS=release-admin@example.com\nOPENWORK_SETUP_CODE=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > "$PROOF_PRIVATE_DIR/release.env"
printf 'Aa1!%s' "$(openssl rand -hex 14)" > "$PROOF_PRIVATE_DIR/password"
printf 'WITNESS_SECRET=%s\n' "$(openssl rand -hex 32)" > "$PROOF_PRIVATE_DIR/witness.env"
docker compose -p mcp-put-proof-release --env-file "$PROOF_PRIVATE_DIR/release.env" -f packaging/docker/docker-compose.eval.yml up -d --wait
python3 evals/fixtures/mcp-put-release-client.py bootstrap
```

Do not overwrite the existing retained `release.env` to restart this lane; simply reuse it and its existing private `state.json`, skipping bootstrap. Start the separate synthetic witness/tunnel, preserving the project boundary:

```bash
docker run -d --name mcp-put-proof-release-witness --label com.docker.compose.project=mcp-put-proof-release --network mcp-put-proof-release_default --env-file "$PROOF_PRIVATE_DIR/witness.env" -v "$PWD/evals/fixtures/mcp-put-release-witness.py:/witness.py:ro" python:latest python /witness.py witness
docker run -d --name mcp-put-proof-release-tunnel --label com.docker.compose.project=mcp-put-proof-release --network mcp-put-proof-release_default cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://mcp-put-proof-release-witness:8080
docker logs mcp-put-proof-release-tunnel > "$PROOF_PRIVATE_DIR/tunnel.log" 2>&1
```

Set `PROOF_MCP_BASE` to the actual HTTPS quick-tunnel URL in that private log. Do not reuse the historical hostname after tunnel shutdown. Then:

```bash
python3 evals/fixtures/mcp-put-release-cases.py preflight
python3 evals/fixtures/mcp-put-release-cases.py proof
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$PROOF_PRIVATE_DIR/ca.key" -out "$PROOF_PRIVATE_DIR/ca.pem" -days 2 -subj '/CN=Release Proof Private CA' -addext 'basicConstraints=critical,CA:TRUE'
openssl req -newkey rsa:2048 -nodes -keyout "$PROOF_PRIVATE_DIR/localhost.key" -out "$PROOF_PRIVATE_DIR/localhost.csr" -subj '/CN=localhost' -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1'
openssl x509 -req -in "$PROOF_PRIVATE_DIR/localhost.csr" -CA "$PROOF_PRIVATE_DIR/ca.pem" -CAkey "$PROOF_PRIVATE_DIR/ca.key" -CAcreateserial -out "$PROOF_PRIVATE_DIR/localhost.pem" -days 2 -copy_extensions copy
python3 evals/fixtures/mcp-put-release-tls.py start
```

Set `PROOF_RCA_PATH` to the read-only RCA's absolute path, then run:

```bash
python3 evals/fixtures/mcp-put-release-tls.py recipe
python3 evals/fixtures/mcp-put-release-cases.py cleanup
docker logs mcp-put-proof-release-witness > "$PROOF_PRIVATE_DIR/witness.jsonl" 2>&1
python3 evals/fixtures/mcp-put-release-client.py export reports/mcp-put-by-key-transcript-new-run.json
python3 evals/fixtures/mcp-put-release-tls.py stop
docker rm -f mcp-put-proof-release-tunnel mcp-put-proof-release-witness
docker compose -p mcp-put-proof-release --env-file "$PROOF_PRIVATE_DIR/release.env" -f packaging/docker/docker-compose.eval.yml down
```

Export while the product container still exists so its actual metadata can be inspected. The helper never automatically retries an uncertain resource create. A repeated proof run needs a clean receipt directory and explicit state handling; do not append another run into the 51-receipt artifact and treat duplicated labels as one run.

## Cleanup actually completed

All created keyed MCP connections and the team were deleted through API-key-authenticated requests. Absent failed/control keys were also checked through idempotent keyed DELETE. Final manageable connection list: `[]` with 200. TLS proxy stopped; witness and quick-tunnel containers removed; Compose `down` completed. No Lane1 project containers remain and its network was removed. Lane2 containers remain running at MySQL 13316 / Redis 16386, unchanged.

Retained deliberately: `mcp-put-proof-release_openwork-eval-mysql` volume (synthetic administrator/organization/API-key metadata, no remaining MCP connections), pulled images, and the owner-only private run directory under `$TMPDIR/opencode/mcp-put-proof-release` containing secrets, state, private raw receipts/logs, and short-lived TLS material. The API key was not revoked; it is not reachable while the stack is down. No private logs or credentials were copied into the public artifacts. No global CA trust was changed.

## Supplemental case 8 — authorized multi-org release deployment

After the original run, the user explicitly authorized a second isolated stack in supported multi-org mode to complete tenant isolation. The original single-org **409** remains valid configuration evidence; it is **not** a product authentication failure and is not rewritten as one.

- Project: `mcp-put-proof-release-tenant`; API `127.0.0.1:18789`, web `127.0.0.1:13006`; separate project network and volume. No Lane2 ports, containers, volumes, specs, or fixtures were changed.
- Base Compose file remains unchanged. Minimal override: `evals/fixtures/mcp-put-release-tenant.compose.yml` sets only `DEN_ORG_MODE: multi_org` on `den` and `web`. Exact supported value was confirmed narrowly in `ee/apps/den-api/src/env.ts:281-294`. Public signup is enabled through the base file's `OPENWORK_ALLOW_SIGNUP=true`; owner allowlist/setup code are empty. No authentication, SSRF, or role checks are disabled by the override.
- Live container inspection confirmed `DEN_ORG_MODE=multi_org`, public signup `true`, API index digest `sha256:e254a3842e7ecb6d0c7128b5f17201e92ac4ee566ad82c70c468938a3faa6407`, and the same arm64 image/config ID `sha256:ab7f9107365c3f8befaf67e6f8f90d159a05fc066172af81ba581c9b7f5b6b11` as the first run. Override SHA-256: `6cb42856970a2e666f24449a9e1faa2865dc5c4a08c40107f76dd3278f5d87da`.
- Two **different** synthetic users each signed up with a directly compliant 32-character password: uppercase/lowercase/digit/special prefix plus 28 random hex characters. Each genuinely created its own organization and issued its own key. GET organization confirmed each as its sole owner/member. Signup/organization/key issuance used the real public/session-authenticated APIs; no setup grant, DB seed, test authentication, or role injection was used.
- The setup API sequence remains an explicitly headless integration path rather than a browser-UI proof. Every one of the **21 acceptance requests** used only its designated `x-api-key`, except missing-key controls; none used session/cookie authentication. Session authentication was restricted to setup and subsequent key revocation.
- A separate synthetic HTTP MCP witness used the existing Lane1 fixture on this project's network, behind its own temporary HTTPS quick tunnel. Source and foreign resources used the same reachable public MCP URL and same external key. No SSRF allowance was introduced, and no Den API key/session was sent upstream.

| Supplemental operation | Actual observation |
| --- | --- |
| User A and B signup | **200 / 200**, distinct user IDs |
| A and B create organization | **201 / 201**, distinct org IDs; subsequent reads **200 / 200**, each owner |
| A and B issue API key | **201 / 201**, distinct issued key IDs and private key values |
| A creates `rs-proof-tenant` | **201**, source resource belongs to A |
| B GET / PUT / DELETE A's source ID | **404 / 404 / 404** (`connection_not_found`); PUT used the real source timestamp and valid body, not malformed input |
| B repeats GET / PUT / DELETE with `x-openwork-org-id: <A org>` | **404 / 404 / 404**; header cannot change key ownership |
| A reads after each foreign operation group | **200 / 200**, same ID, original name and timestamp; rejected writes/deletes did not mutate or remove it |
| B list before own resource creation | **200**, empty list |
| B creates same external key in B | **201**, distinct `emc_` ID, same key `rs-proof-tenant` |
| A list / B list / B list with spoofed A-org header | **200 / 200 / 200**; each exactly one own resource, no overlap; spoofed B request still lists B's resource |
| A attempts GET of B's new resource | **404** |
| Missing key GET / PUT | **401 / 401** |
| Random invalid key GET / PUT | **401 / 401**; random value redacted, never published |
| Final A and B lists | **200 / 200**, still exactly their own resources; no unauthorized key created |
| A and B delete own keyed resource | **200 / 200**, `deleted:true`; subsequent lists **200 / 200**, both empty |
| Revoke A and B keys using their legitimate owner sessions | **204 / 204**; subsequent requests with those keys **401 / 401** |

Supplemental artifact: `reports/mcp-put-by-key-tenant-transcript-2026-09-14.json` — **37 sanitized complete receipts** (8 setup + 21 acceptance + 8 cleanup), selected live image/configuration metadata, and synthetic identity IDs. A jq `--exit-status` consistency check evaluated to `true` for distinct identities/key IDs, six 404 denials, unchanged source, same-key distinct resources/disjoint lists, missing/invalid-key rejection, empty cleanup lists and successful key revocation. This is receipt validation, not a claim that the deferred testkit run has executed.

The original transcript still has **51 receipts** and SHA-256 `c5f6ca7feb2abf0ec2229630cb78f981dec0b0fe5ee06e5998a21fd6d131f6bc`. Neither its metadata nor its original configuration-blocked coverage field was edited. Both exporters now refuse to overwrite an existing transcript; use a new filename for a fresh reproduction. The original password reproduction command now generates `Aa1!` plus `openssl rand -hex 14` directly, and the bootstrap helper consumes that exact password instead of transforming/truncating a 64-character value. The tenant preparation helper uses the same directly compliant construction; both real signups succeeded on their first attempt.

### Supplemental reproduction

Use a fresh owner-only private directory for a new run; the preparation command refuses existing state. Run from the assigned worktree, with no other stack using the tenant project name or its ports:

```bash
set -euo pipefail
export PROOF_PRIVATE_DIR="${TMPDIR%/}/opencode/mcp-put-proof-release-tenant-new-run"
umask 077
mkdir -p "$PROOF_PRIVATE_DIR"
python3 evals/fixtures/mcp-put-release-tenant.py prepare
docker compose -p mcp-put-proof-release-tenant --env-file "$PROOF_PRIVATE_DIR/release.env" -f packaging/docker/docker-compose.eval.yml -f evals/fixtures/mcp-put-release-tenant.compose.yml up -d --wait
python3 evals/fixtures/mcp-put-release-tenant.py bootstrap
docker run -d --name mcp-put-proof-release-tenant-witness --label com.docker.compose.project=mcp-put-proof-release-tenant --network mcp-put-proof-release-tenant_default --env-file "$PROOF_PRIVATE_DIR/witness.env" -v "$PWD/evals/fixtures/mcp-put-release-witness.py:/witness.py:ro" python:latest python /witness.py witness
docker run -d --name mcp-put-proof-release-tenant-tunnel --label com.docker.compose.project=mcp-put-proof-release-tenant --network mcp-put-proof-release-tenant_default cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://mcp-put-proof-release-tenant-witness:8080
docker logs mcp-put-proof-release-tenant-tunnel > "$PROOF_PRIVATE_DIR/tunnel.log" 2>&1
```

Export `PROOF_MCP_BASE` as the actual HTTPS tunnel origin in that private log, then:

```bash
python3 evals/fixtures/mcp-put-release-tenant.py proof
python3 evals/fixtures/mcp-put-release-tenant.py cleanup
python3 evals/fixtures/mcp-put-release-tenant.py export reports/mcp-put-by-key-tenant-transcript-new-run.json
docker rm -f mcp-put-proof-release-tenant-tunnel mcp-put-proof-release-tenant-witness
docker compose -p mcp-put-proof-release-tenant --env-file "$PROOF_PRIVATE_DIR/release.env" -f packaging/docker/docker-compose.eval.yml -f evals/fixtures/mcp-put-release-tenant.compose.yml down -v
```

Supplemental transcript SHA-256: `8df72de0df9edc56606aa0f72e5d40f448ea26afd726da503327787682d7ca0e`. Static checks were rerun after the spec update: focused dependency lint passed (5 modules / 4 dependencies); Python compilation passed for the modified client and new tenant helper. Full typecheck still reports the same two out-of-scope diagnostics listed above, with no error in the new/updated spec; full layer lint still reports 54 violations outside the new spec. These remain unresolved, not classified as pre-existing without a clean control. The narrow testkit run remains assigned to the orchestrator, and no testkit pass or published evidence is claimed here.

### Supplemental cleanup actually completed

Both MCP resources were API-deleted, both lists were empty, both issued API keys were revoked and rejected afterwards. Witness/tunnel containers were removed. Compose **`down -v` completed**, removing all supplemental product containers, its project network, and `mcp-put-proof-release-tenant_openwork-eval-mysql`. No tenant-project containers, networks, volumes, or exposed ports remain. The original Lane1 retained volume/private environment were not changed, and Lane2 MySQL 13316 / Redis 16386 remain running untouched. Private supplemental credentials, raw receipts/logs, and state remain only in the owner-only `$TMPDIR/opencode/mcp-put-proof-release-tenant` directory; those keys are revoked and the supplemental database is gone. Pulled shared images remain cached. Nothing was staged or committed.
