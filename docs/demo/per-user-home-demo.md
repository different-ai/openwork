# Per-user Home — hosted identity, synthetic content

**Incomplete.** Main executed the coded spec once; the independent attempt could not establish hosted member access. See the current receipts below. The following operator script remains the handoff for completing the missing proof. No member OAuth grants were available at handoff; opening the hosted sign-in browser timed out and the operator was asked to sign in manually. No hosted connection change, consent, capture, or assembly has been completed; the local world and single red coded run are documented below. Preserve the inherited `eng-105-dashboard-demo.md` at `f906529b9` and all existing Blob captures/films byte-for-byte. Their older synthetic Calendar identities do not prove this journey.

## Two distinct topologies

| Surface | Meaning and boundary |
|---|---|
| Already-running isolated world | Owner-supplied **v0.18.46 release source**, `a0d6bd1de8debf4f09d22b8538e124b2ff45b339`, not a packaged binary. Den Web/API ports **3005/8790**; desktop aliases **A/B**, CDP **54343/54539** at handoff. Check ownership/liveness before reuse; these are not permanent endpoints. |
| Hosted identity target | New provider `https://acme-home-demo-loo267kwv-prologe.vercel.app/mcp`, `IDENTITY_MODE=openwork`, upstream `https://app.openworklabs.com/api/auth`. Names come from **real hosted OpenWork members**; the three business-content sets remain synthetic, keyed by **`org_id|sub`**. Aliases A/B are recording labels, never substitute provider names. |

The hosted provider cannot reach the operator's `127.0.0.1`. Local-world accounts, cookies, registration receipts, and prior synthetic-name demos do not establish hosted sign-in or member consent. The dashboard host organization and upstream hosted identity organization are separate fields in the private receipt; do not assume they are the same. If using hosted Den to own the dashboard, both desktops must be signed into that host organization. Hosted Den's running build is not thereby v0.18.46; the release label applies to the owned desktops only.

Private world inventory: `evals/results/.worlds/scripts/acme-demo-eng105.json`. The main owner may inspect required fields privately; **never dump the file**, credentials, organization names/IDs, email addresses, OAuth URLs, or customer names into logs, this document, or public media.

## Operator run (12 steps maximum)

| # | Action | Expected observation / stop condition |
|---|---|---|
| 1 | Main verifies the existing world/profile ownership, release receipt, and A/B CDP endpoints. Do not boot, stop, replace, install dependencies, change permissions, or edit product source. | Two distinct real Electron desktops; preserve pre-existing generated-file changes. Release/source provenance is owner-supplied, not newly certified by this spec. |
| 2 | In separate owner-controlled browser profiles, manually sign two real members into the **hosted** Den upstream. Confirm each exact display name and distinct subject in the same hosted organization privately. | A real session for each member, not local seeded accounts or copied tokens. If either sign-in is blocked, record Incomplete. No automated OAuth or credential capture. |
| 3 | On the intended dashboard host, create a **new** connection named **Acme Home (per-user)**; leave old Home/Calendar connections untouched. Set OAuth, **per_member**, URL to the new preview `/mcp`, issuer to that preview's origin, scope **`home:read`**, and public-client DCR. | Provider's upstream OAuth requests **`openid profile email`**. Registration is not consent. Verify the deployed `IDENTITY_MODE=openwork` and hosted upstream configuration privately; never replace it with a synthetic identity mode. |
| 4 | Through Den UI, add the **Acme Home** full-shell App (`acme_home`, `ui://acme-home/home.html`) to a new demo dashboard with default `{}`. Share with the two **named** host members only, including the second member; leave organization-wide sharing off. Open that same tile on both desktops. | Both desktop accounts must belong to the dashboard host organization. No name/subject/token/payload in launch arguments. If the host gates catalog access before consent, record that blocker; do not bypass the gate with API-authored tiles or borrowed grants. |
| 5 | Before either member connects the new provider, prepare the private owner receipt below and set the environment. Keep only one Home frame/tile mounted per desktop; disable widget auto-polling manually. | Receipt contains real hosted identity observations and actual setup IDs, not placeholders. A/B are aliases only. Metadata/receipts are setup attestations, not automated proof of consent or UI sharing. |
| 6 | **Main runs the command below once.** The spec makes one unauthenticated protected-widget request and reads each already-open real desktop. | Direct provider must return **401**. A mounted anonymous shell must show **Connect to personalize**, no personal name, and no widget items. A host **409 connection_not_ready** is a separate earlier gate, not equivalent to provider 401 or proof the shell rendered. Record only an actually observed host status; never infer 409 from a missing iframe. |
| 7 | After `[PERUSER] Before-connect observations recorded`, each member independently uses **Connect** and completes the hosted consent UI. Return to/open or refresh that same dashboard tile on their desktop. | No grant/code/token copying. Maximum wait is five minutes per member; A and B are checked independently. Do not revoke an existing grant to manufacture the before-state; if already connected, disclose the missing before-state. |
| 8 | Let the spec compare the connected views. Do not navigate or change filters during the checks. | Each rendered greeting matches that member's exact hosted display name; names differ. Today, Attention, and Goals each have a nonempty set of visible item titles, and **all three sets differ between A/B**. The same dashboard and entry IDs are present on both desktops. |
| 9 | The spec clicks each released tile-header **Refresh Acme Home** once, not an unreleased options menu, and polls for the resulting widget generations. | All three generations increase on the same provider instances; the real name stays stable and at least one visible content element rotates. The other desktop's view must remain unchanged. Instance changes/resets are recorded but do **not** pass the strict increment claim. No repeated click until a favorable instance appears. |
| 10 | Preserve the runner's exact command, placement, exit code, and passed/failed/skipped counts, plus its finalized `test-run.json` and latest `per-user-home-receipt` artifact. | Missing members, consent, shell, tile, selectors, or setup receipts remain **Failed/Incomplete**, with a nonzero test result, never skip/dummy success. Red independent phases remain red even when later views render. |
| 11 | If main elects to capture, use a separate passive CDP screencast session per owned desktop during this same run, outside auth screens. Keep raw owner frames immutable/private, review/redact derived media, and bind frame hashes/times/member aliases to the exact finalized run receipt. | No global browser/download/permission changes. No old Blob footage as new evidence. Missing current frames or receipts means **PARTIAL**, not a fabricated movie or a completed identity demo. The spec itself takes no screenshots or films. |
| 12 | Assemble only reviewed owner media into new `reports/demo/per-user-video/<ts>/PERUSER-A.mp4` and `PERUSER-B.mp4`, with the exact opening card below and visible PARTIAL labeling for incomplete proof. | Never overwrite inherited films or publish names/org/email/customer data. Movies illustrate assertions; they cannot decide the verdict. No assembly has been executed or final videos produced by this handoff. |

## Private input and run-once command

`PERUSER_MEMBERS_RECEIPT` points to an existing owner-only JSON file outside tracked files. It contains **no credentials**. Populate the following shape from actual hosted-session and UI setup observations, not from this example. `hostMemberId` identifies a dashboard-host membership; `sub` identifies the independently signed-in upstream member. Do not print or commit its contents.

```json
{
  "identityMode": "openwork",
  "upstreamAuthUrl": "https://app.openworklabs.com/api/auth",
  "desktopSourceSha": "a0d6bd1de8debf4f09d22b8538e124b2ff45b339",
  "desktopVersion": "0.18.46",
  "connection": {
    "url": "https://acme-home-demo-loo267kwv-prologe.vercel.app/mcp",
    "authType": "oauth",
    "credentialMode": "per_member",
    "issuer": "https://acme-home-demo-loo267kwv-prologe.vercel.app",
    "scopes": ["home:read"],
    "dcr": true
  },
  "dashboard": {
    "id": "<actual dashboard ID>",
    "entryId": "<actual shared tile entry ID>",
    "hostOrgId": "<actual dashboard host organization ID>",
    "toolName": "acme_home",
    "resourceUri": "ui://acme-home/home.html",
    "launchArguments": {},
    "orgWide": false,
    "namedMemberIds": ["<host membership A>", "<host membership B>"]
  },
  "members": {
    "A": { "name": "<exact hosted display name A>", "sub": "<hosted subject A>", "orgId": "<hosted organization>", "hostMemberId": "<host membership A>", "hostedSessionVerified": true },
    "B": { "name": "<exact hosted display name B>", "sub": "<hosted subject B>", "orgId": "<same hosted organization>", "hostMemberId": "<host membership B>", "hostedSessionVerified": true }
  }
}
```

From the owned `/Users/guillaume/Dev/openwork-eng105-release` checkout, after main has set `PERUSER_MEMBERS_RECEIPT` to that private path and verified the endpoint ownership:

```sh
OPENWORK_EVAL_E2E_TESTS=1 \
PERUSER_MEMBERS_RECEIPT="$PERUSER_MEMBERS_RECEIPT" \
PERUSER_MCP_URL=https://acme-home-demo-loo267kwv-prologe.vercel.app/mcp \
PERUSER_UPSTREAM_AUTH_URL=https://app.openworklabs.com/api/auth \
PERUSER_A_CDP_URL=http://127.0.0.1:54343 \
PERUSER_B_CDP_URL=http://127.0.0.1:54539 \
PERUSER_CONSENT_WAIT_MS=300000 \
pnpm evals:e2e per-user-home-demo --local
```

This imports `test` from `@openwork/testkit`, attaches through `@openwork/cdp`, and reuses the released nested-srcdoc/isolated-context pattern in `eng-105-dashboard-demo.e2e.test.ts`. It deliberately does **not** call that older spec's cold-boot world helper, create browsers, navigate to authentication, fabricate data, or use mocks/skips. Disposing attached surfaces only closes their CDP sockets, not the desktops. Missing configuration still records failed assertion evidence. The testkit owns the canonical run directory under `evals/results`; sanitized phase artifacts bind to its exact `test-run.json` path/run ID. No names, subjects, organization identifiers, raw response bodies, or credentials are emitted by the spec.

The selectors match the Home UI contract: full real name from `[data-testid="today-identity"]` (the `h1` contains only the first name), `.widget-{today,attention,goals}`, `.detail summary`, row content test IDs, `.receipt strong`, and `.receipt span[title]`. The preview's uncommitted deployment source has **not** been verified here; if its DOM differs, report the exact contract mismatch and review it rather than weakening assertions. The spec compares visible item-title sets, not every detail field, and checks observed isolation/refresh, not exhaustive authorization security. Hosted sign-in, `org_id|sub` derivation, connection configuration, UI sharing, and release provenance remain owner-attested prerequisites, not independently automated assertions. Counter instance changes cannot establish durable monotonic generation.

## Video boundary

Exact opening card:

> Per-user dashboard on OpenWork v0.18.46 — two members, two identities, same tile

Reuse the timestamp-preserving `scripts/demo/video/prepare-cdp.ts` only after main has finalized a **new** owner screencast and selected a **new** output path:

```sh
node scripts/demo/video/prepare-cdp.ts "$PERUSER_FINALIZED_FILM_DIR" "$PERUSER_NEW_INTERMEDIATE_MP4"
```

That command is conversion only, **not** the final captioned A/B movies. The existing C/D assembler's completion schema requires the older ten-claim ENG-105 journey; do not feed it these new receipts, rename its output to imply this journey, or alter its inherited captures. A new per-user final-assembly adapter is deferred until actual owner frames and finalized run receipts exist. No capture/assembler script or placeholder media is needed to run the requested spec; video delivery remains **PARTIAL / unavailable** at this handoff.

Optional local-upstream alternative: only if main independently estimates a sub-hour isolated run, outline a separately reachable local identity-provider topology and two local test members. It would prove local integration, **not** the required hosted real-member identity target. No tunnel, provider redeployment, world change, or implementation of that alternative is authorized here; hosted consent comes first.

## Preparation checks and remaining limits

- `pnpm --dir evals run typecheck` and `pnpm --dir evals run lint:layers` were attempted as static checks only. Both exited **127**: `zsh:1: command not found: pnpm`. Classification: **environment-blocked / Incomplete**, not a product regression or a passing check. No dependency installation or PATH/configuration change was attempted. Main must run these commands in its prepared shell before the single E2E execution.
- `git diff --check` exited **0**. `git diff --no-index --check /dev/null <each-new-file>` emitted no whitespace diagnostics and exited **1** (the new files differ from `/dev/null`; no-index implies diff exit status). The inherited-demo comparison exited **0**: existing demo docs and `scripts/demo/video` are unchanged against `f906529b9`. The pre-existing `ee/apps/den-web/next-env.d.ts` change was left alone. Only this document and the requested spec were added.
- Preparation HEAD: `f906529b9bbc1a4c25359754f73518dfec994413`; observed `origin/dev`: `65c4286a9006297b0c10b9bf1324fa7c00c422a8`. Warden status is **Not reviewed**; runtime assertion coverage, deployed DOM compatibility, and final A/B video assembly remain incomplete.

## Main execution receipts — 2026-09-15

- One local run: `OPENWORK_EVAL_E2E_TESTS=1 PERUSER_MCP_URL=https://acme-home-demo-loo267kwv-prologe.vercel.app/mcp PERUSER_UPSTREAM_AUTH_URL=https://app.openworklabs.com/api/auth PERUSER_A_CDP_URL=http://127.0.0.1:54343 PERUSER_B_CDP_URL=http://127.0.0.1:54539 PERUSER_CONSENT_WAIT_MS=1000 pnpm evals:e2e per-user-home-demo --local`. Exit **1**, **0 passed / 1 failed / 0 skipped**. Provider 401 assertion Passed; desktop phase **Incomplete**, missing actual private hosted identity/setup receipt. No receipt was fabricated to bypass that prerequisite.
- Finalized runner: `evals/results/test-runs/2026-09-15T17-14-28-091Z-per-user-home-real-hosted-member-names-isolated-three-widget-sets-and-fresh-gene/test-run.json`; 1 passed assertion and 1 failed assertion, zero pending judgments. It records preparation HEAD plus the then-uncommitted spec. This is red diagnostic evidence, not a passing final-head run; the requested single run was not repeated.
- Independent fresh session `ses_f59f0e7abffeLE55WbsEd0lqc3`, requested org-default GPT model / low: **steps 1–12 Incomplete**, no runtime claim certified. App-context timeout; no conversation browser tabs or authorized isolated-desktop observation action. No real names, subjects, consent, tile or widget comparison observed. No product failure inferred. One rerun remains reserved for after human access is supplied.
- Main broad `pnpm --dir evals run typecheck` exited **2** with repository-wide module-resolution/schema errors and one introduced record-narrowing error in the new spec. The latter was fixed before the single run; broader errors are **unresolved**, not labeled pre-existing without a clean control. The two standalone provider repositories passed their own typecheck/build/lint and 46/49 Node plus 12/5 browser tests respectively; those are not hosted member proof.
- No current accepted screencast exists; **PERUSER-A.mp4 / PERUSER-B.mp4 were not produced or copied**. Reusing old Blob footage or filming an unrelated idle desktop would misrepresent this journey. Video delivery remains Incomplete until actual member consent and an authorized observation/capture path are available.
- One operator world remains alive at handoff: Den Web `http://127.0.0.1:3005`, API `http://127.0.0.1:8790`, desktop A CDP `http://127.0.0.1:54343`, B CDP `http://127.0.0.1:54539`. Check live ownership/health before reusing.
