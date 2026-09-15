# ENG-105: a shared dashboard with personal data

**ENG-105 items 1 and 2: PASSED on OpenWork v0.18.46 source.** The coded run passed 9/10 claim groups; its runner remains Failed (exit 1, 0 passed tests / 1 failed / 0 skipped) solely because the additional World Clocks fresh-render persistence assertion exposes the known process-local memory limitation. That assertion is not waived. Independent D completed the operator journey: steps 1–19 observed Passed, step 20 failed on the original run and varied on a later replay. This independently confirms the primary scope, not durable Clock persistence or a 20/20 green runner. See [options and verification boundaries](eng-105-options.md).

Den Web creates and shares a managed dashboard; two isolated desktops render its real MCP Apps. No chat “Save as app,” generated Workflow snapshot, or shared calendar credential substitutes for this journey. Home and World Clocks are demonstrated first so their working path remains observable if Calendar is blocked.

## Build, placement, and startup

Use your own **release-based** checkout. The operator's prepared checkout is `/Users/guillaume/Dev/openwork-eng105-release`, branch `demo/eng-105-release`; an independent reviewer uses the separate `runtimeCheckout` supplied in their world outputs. Product source must equal **v0.18.46**, SHA `a0d6bd1de8debf4f09d22b8538e124b2ff45b339`; only demo world/docs/setup/spec overlays are allowed. The world checks actual source provenance before boot.

The required seeded topology cannot inject release images or use Daytona placement. The approved lane is **local-release-source**, not packaged-binary validation. A later development checkout is not release proof. Shipped tiles use a visible header **Refresh** button, not the newer compact App-options menu.

```sh
pnpm install --frozen-lockfile
pnpm --dir evals install --frozen-lockfile
pnpm --filter @openwork/types build
pnpm --filter @openwork-ee/den-db build
pnpm --filter @openwork/email build
pnpm world up acme-demo-eng105 --detach
```

The three package builds are required on a fresh checkout (installing dependencies alone does not create `@openwork/email/dist/index.js`). A local MySQL test service must also be available at `127.0.0.1:3306`; if none is running, `pnpm dev:den:mysql` starts the repository's development service. Do not restart or replace an existing service.

For automated execution, launch long boot/test/render commands detached or in an owned background process with a log and exit receipt; poll in short calls. Do not kill or attach to another session's processes. Keep the world alive for the operator run, and stop only your world with `pnpm world down acme-demo-eng105` afterward.

World outputs are authoritative for `releaseTag`, `releaseSha`, `lane`, `denWeb`, `denApi`, `homeMcpUrl`, `clocksMcpUrl`, `calendarMcpUrl`, both desktop CDP endpoints, account emails, `registrations`, `reapplyRegistrations`, and `setupExitCodes`. Read passwords only from private secret outputs, never copy them to chat, docs, or recordings. Default Den API/Web ports are **8790/3005**. Alex and Jordan must use separate Den browser profiles and different desktop profiles.

| App | Hosted MCP endpoint | Launch | Account mode |
|---|---|---|---|
| Acme Home | `https://acme-home-demo.vercel.app/mcp` | `acme_home {}` | none/shared |
| World Clocks | `https://world-clocks-demo.vercel.app/mcp` | `show_world_clocks {}` | none/shared |
| Personal Calendar | `https://personal-calendar-demo-mcp-app.vercel.app/mcp` | `show_calendar {}` | OAuth/per-member; `calendar:read` |

Home source: [yomgui/acme-home-demo](https://github.com/yomgui/acme-home-demo), original film's verified deployment source `aa0f1b7aaa72fe4d41d9f0ee9408b83c80b53575`; UI resource `ui://acme-home/home.html`. Calendar source is the **private** [yomgui/personal-calendar-demo-mcp-app](https://github.com/yomgui/personal-calendar-demo-mcp-app) repository, verified deployment commit `9051e3ca73822581f44ff4d489404062f9f3af59`, resource `ui://personal-calendar/mcp-app.html`, issuer `https://personal-calendar-demo-mcp-app.vercel.app`, with public-client DCR (`token_endpoint_auth_method: none`). Metadata discovery is public; calendar/identity data calls still require a verified token. Direct deployed OAuth/tool tests succeeded for two different synthetic identities; that is not yet proof of isolation through the released OpenWork host.

Current Home deployment note (operator-reported, not reverified by this docs-only update): both production projects now use Acme `main` source `3b335ed` in two modes. The shared world/H endpoint remains **`https://acme-home-demo.vercel.app/mcp`**, anonymous/shared; the separate **`https://acme-home-demo-peruser.vercel.app/mcp`** uses `IDENTITY_MODE=openwork` and OAuth/per-member. Do not substitute the per-user endpoint into the shared world/H setup. See [current per-user protocol verification and setup](per-user-home-demo.md#current-protocol-verification). The original `aa0f1b7` film, historical receipts, and red runs remain unchanged and are not recertified against `3b335ed`.

World Clocks uses the demo-only deployment of canonical source `0e0e70f32163687512c09e24ae68334a5a47dedd`: seven tools, with the launch and three app-only helpers bound to `ui://world-clocks/mcp-app.html`. Write annotations remain intact. Access to the original Vercel team was denied, so only this demo's configuration points to the new `world-clocks-demo` URL; the original `world-clocks-six` deployment and existing organization connector are unchanged. An authorized admin must separately migrate that connector or redeploy the fix to the original team.

### Den Add app picker: exact cards to add

The World Clocks connection currently shows **FOUR entries**: **World Clocks** (`show_world_clocks`), **Resolve locations** (`resolve_locations`), **Get my preferences** (`get_preferences`), and **Save my preferences** (`save_preferences`).

Add ONLY the first card, "World Clocks" (Run automatically). The other three are internal helpers the tile calls itself; do not add them as tiles — "Save my preferences" would write on every refresh.

The helpers' `ui://world-clocks/mcp-app.html` binding is required by the released host for calls from the tile. **Product finding:** `visibility: ["app"]` with `resourceUri` currently leaks app-only helpers into the picker; the picker should hide them while preserving that binding. This documentation does not fix the picker.

The other connections' exact card titles, checked against their registration source (not a new live-host verification), are:

| Connection | App cards | Add for this demo |
|---|---|---|
| Personal Calendar | **Personal Calendar (demo)** (`show_calendar`) | **Personal Calendar (demo)** with `{}`; enable **Run automatically / Auto-run**. `Who am I (synthetic demo)` (`whoami`) has no UI binding and is not an App card. |
| Acme Home | **Today at a Glance** (`acme_today`), **Needs Your Attention** (`acme_attention`), **My Goals** (`acme_goals`), **Acme Home** (`acme_home`) | Only **Acme Home** with `{}`; enable **Run automatically / Auto-run**. The other three are valid standalone widgets, not app-only helpers, but are not the full Home shell. |

Source backing: World Clocks `server/server.ts` registers the four UI-bound tools and `shared/types.ts` defines the launch title; Personal Calendar `server/server.ts` uses the title from `shared/contract.ts`; Acme Home `server/server.ts` registers all three widgets and Home via `server/register.ts`, with titles from `shared/contract.ts`. These are the respective app repositories, not OpenWork product files.

### Calendar's deliberately limited demo authorization

The embedded **demo authorization server — accepts every request** auto-approves a fresh synthetic identity without a password or picker. Signed, short-lived authorization codes are PKCE-bound but **not single-use**. Access tokens are verified for signature, issuer, and the Calendar resource audience. This is not production-grade identity assurance or a full OAuth 2.1 security claim.

Each member clicks Connect independently. Their displayed synthetic names are derived from separate token subjects, not the account names “Alex” and “Jordan.” Record the displayed names, fingerprints, and meetings. No real calendar data is used.

Refresh uses a **per-instance generation counter**, plus visible `instanceId` and `generatedAt`. It is not a durable/distributed counter: generation must increase on the same instance, but can reset on a new Vercel instance. Record that transition explicitly; never silently relabel a reset as an increment. Identity and meeting isolation must hold across instances.

### Historical local readiness receipt — stopped

A release-source smoke on overlay `0ffdedc85` booted v0.18.46 in 1m49s: Den API/Web **8790/3005**, signed-in `alex@acme.test` and `jordan@acme.test`, Alex/Jordan CDP **55559/55810**. All three connection PUTs returned **201**, then **200** on reapply with stable IDs and empty changed-field lists; exit codes `[0,0]`. Calendar was OAuth/per-member, organization-wide, and not connected for either member. That checkpoint used the earlier `calendar.read` scope; the final script uses **`calendar:read`**, requiring a fresh final receipt.

That world is stopped. CDP ports above are historical—never attach blindly. This is configuration readiness, not C's full UI proof. An earlier development-source smoke is excluded from release validation.

## Operator script (20 steps)

| # | Action | Expected observation |
|---|---|---|
| 1 | Start the world and inspect build/setup outputs. | Exact release SHA, two different signed-in members, three successful connection registrations, and successful stable-ID reapply. Record failures rather than claiming readiness. |
| 2 | In an isolated browser profile, open `denWeb` and sign in as Alex using private world outputs. | Alex is the organization owner; **Manage → Dashboards** is available. |
| 3 | Open the organization's connections page and click **Configured** to inspect installed connections rather than the connector catalog. | Acme Home, World Clocks, and Personal Calendar are registered. Calendar is **Individual accounts / per-member**, OAuth—not a shared API key. Registration alone does not mean it is connected. |
| 4 | Open **Manage → Dashboards → New dashboard**, name it **Acme Day**, and click **Create dashboard**. | An empty dashboard detail page with app/access controls opens. |
| 5 | **Add app → MCP → Acme Home** connection; click **Add on the “Acme Home” App row**, then **Done** and enable **Auto-run**. | The full `acme_home` shell is saved—not the standalone **Today at a Glance**, **Needs Your Attention**, or **My Goals** cards. No chat-save step is used. |
| 6 | In **Add app → World Clocks**, add only the first **World Clocks** card with default `{}` and enable **Run automatically / Auto-run**; ignore the three internal helper cards listed above. | One clock App reference is saved, never **Resolve locations**, **Get my preferences**, or **Save my preferences**. Do not supply `cities`: explicit launch cities override saved preferences. |
| 7 | Under **Who sees this dashboard**, leave **Everyone in the organization** off. **Add person → Search people...**, select Alex and then Jordan by world email, and **Grant** each. | Exactly the named viewer grants exist; sharing stores App references, not another member's calendar data. |
| 8 | Open **Dashboard** in Alex's isolated desktop. | **Acme Day**, Home, and live World Clocks render under **From your company**. Launch controls may say **Organization auto-run**. |
| 9 | In a second isolated browser profile, sign in to `denWeb` as Jordan. | Jordan's account is visible; no Alex authentication cookie is reused. |
| 10 | Open **Dashboard** in Jordan's isolated desktop. | The same shared dashboard, Home, and World Clocks render without Jordan creating a dashboard. |
| 11 | As Alex in Den Web, open **My Library → MCPs → Personal Calendar → Your Connections → Connect**. | The demo OAuth redirect auto-approves and returns connected. No typing, identity picker, or shared credential is used. A failed return fails this step. |
| 12 | As Alex, reopen Acme Day's Den Web detail and add the **Personal Calendar (demo)** App row with `{}`; enable **Auto-run**. | The third App is a real `ui://` reference. Launch arguments contain no identity, bearer token, or copied payload; named grants remain unchanged. |
| 13 | As Jordan in the separate Den Web profile, open **Your Connections → Personal Calendar → Connect**. | Jordan's independent OAuth connection returns connected. No code/token from Alex's flow is reused. Attempt this independently even if Alex's connection failed. |
| 14 | Reopen/reload the dashboard on both desktops to load Calendar. | Both render **Signed in as**, nonempty meetings, identity fingerprint, generation, instance ID, and generated time. Record each member's result separately. |
| 15 | Record Alex's view as `A` and Jordan's as `J`; compare them. | `A.name != J.name`, `A.identity != J.identity`, and meeting sets differ. Identical calendars fail ENG-105; if a member cannot render, record the comparison as blocked—not passed. |
| 16 | Click Alex's visible calendar-header **Refresh** (`Refresh Personal Calendar`). | A new tool call uses unchanged `{}`. Identity/meetings remain Alex's. Generation increases on the same instance; if the instance changed, record its reset explicitly and do not claim durable monotonicity. |
| 17 | Repeat Calendar **Refresh** on Jordan's desktop and compare again. | Jordan's identity/meetings stay Jordan's and differ from Alex's; the same-instance generation rule holds. No reconnect/account switch is required. |
| 18 | In Alex's World Clocks, **Edit → Add a city**. Select an absent city, e.g. Tokyo, and increase **Clocks shown** if needed. A save confirmation may appear immediately; handle it as in step 19. | The new city and IANA timezone are visible; this edits the App, not stored launch arguments. A clock failure must not hide the preceding Calendar verdicts. |
| 19 | If the released host shows **“Allow this MCP App to call save_preferences on …?”**, accept only the confirmation for this World Clocks connection. Then wait for the save message and click **Done**. | **Saved (shared with everyone)** or **Saved to your account** confirms the server tool acknowledged the edit. Organization auto-run covers launch, not this write helper; Done alone is not a save receipt. |
| 20 | Click the clock tile-header **Refresh** (`Refresh World Clocks`) and inspect whether the added city/settings remain. | **Incomplete — known limitation** when fresh output reverts to defaults: the shared in-memory store can reset across Vercel instances. Attempt and record the actual result; do not alter `{}` or retry until a favorable instance makes it pass. The strict coded persistence assertion remains unchanged. |

Record sharing/rendering (1–10), each member's Calendar connection/render/refresh and comparison (11–17), and clock editing (18–20) independently. Continue independent groups after a failure; mark dependent observations blocked with the exact visible cause. Overall Passed requires every required observation to pass.

## Reproduce on another Den

**H status: two-stage setup and ownership-safe cleanup are implemented and fixture-tested. Bounded production connection provisioning/idempotence/cleanup passed; live two-stage dashboard proof is still pending.** Default apply creates **`<prefix>ENG105 API Demo`** with Home + World Clocks and named sharing, never Acme Day. Calendar is added only after member consent. A printed `MANUAL_STEP` is not full three-App readiness.

Prerequisites: Den **≥0.18.43**, dashboard feature enabled, a target-org admin API key, Bash, curl, jq, and Infisical configured for your authorized project when using these commands. Check the route:

```sh
curl -sS "$DEN_API_URL/openapi.json" | jq '.paths|has("/v1/mcp-connections/by-key/{externalKey}")'
```

Inject `DEN_API_KEY` through the environment, never command arguments or committed files. Set `INFISICAL_DEMO_PATH` to an authorized folder containing it. Preserve a separate private `DEMO_STATE_DIR` for each target/prefix through teardown. Optional `DEMO_EXPECTED_ORG_ID` refuses the wrong org; `DEMO_TEAMMATE_EMAIL` opts into member/invitation handling and named sharing (omit to invite nobody). Existing invitations are preserved; an invited teammate must accept before a rerun can add their named dashboard grant.

```sh
export DEN_API_URL="https://den.example.com"
export DEMO_KEY_PREFIX="demo-eng105-"
export DEMO_STATE_DIR="$HOME/.local/state/eng105-den-example"
# Set INFISICAL_DEMO_PATH to your authorized secret folder.

# Stage 1: connections + shared Home/Clocks tiles and named sharing.
infisical run --env dev --path "$INFISICAL_DEMO_PATH" --silent -- bash scripts/demo/setup-eng105-den.sh --apply

# Each member manually Connects Calendar. Then the connected API caller may run:
infisical run --env dev --path "$INFISICAL_DEMO_PATH" --silent -- bash scripts/demo/setup-eng105-den.sh --after-connect

# Verify; add --after-connect here to require all three tiles rather than stage 1.
infisical run --env dev --path "$INFISICAL_DEMO_PATH" --silent -- bash scripts/demo/setup-eng105-den.sh --verify
infisical run --env dev --path "$INFISICAL_DEMO_PATH" --silent -- bash scripts/demo/setup-eng105-den.sh --teardown
```

Apply a second time to verify **PUT 200s**, unchanged IDs, and empty diffs. Base keys: `acme-home-demo`, `world-clocks-demo`, `personal-calendar-demo`; all have organization-wide access and direct exposure disabled. Optional endpoint overrides: `DEMO_HOME_URL`, `DEMO_CLOCKS_URL`, `DEMO_CALENDAR_URL`, `DEMO_CALENDAR_ISSUER`; `DEMO_CALENDAR_SCOPES` is a JSON array. Conflicting existing identity/auth/issuer/scopes or unreadable grants are preserved, not silently migrated.

Stdout is a sanitized JSON array; stderr carries a table/diff/manual steps. On versions without by-key GET, an exact 404 is recorded, followed by public list/detail lookup matching `externalKey` exactly. A 401/403/server error never authorizes fallback. `connected: unknown` means the field was absent, not success.

**Manual on every Den:** each member separately clicks Calendar **Connect**. Before consent, Den correctly returns HTTP **409** with `{"error":"connection_not_ready","message":"Connect your account before using this MCP's tools."}` even though the provider's metadata is public. The script retains this as an expected consent receipt (`ok:false`), creates the two shared tiles, and explains the next action. It never borrows another member's OAuth grant. After the API caller connects, `--after-connect` appends Calendar only to the exact untouched script-owned two-tile dashboard. Alternatively add Calendar through Den Web. If dashboard APIs are absent, use steps 4–7 and 15. The local world uses `--connections-only` twice, preserving the primary UI authoring journey.

Teardown uses the owner manifest, deleting only resources recorded as created; existing resources and replacement IDs are preserved. It never removes a member because an invitation was accepted. Production proof uses `rsproof-eng105-` and an explicit expected-org guard, then cleans up only its resources.

## Verification and recording

C's spec: `evals/specs/eng-105-dashboard-demo.e2e.test.ts`. H's safety spec: `evals/specs/eng105-setup-script.test.ts`. **Zero skips** and observable assertions for every claimed behavior are required for Passed. Setup/API receipts do not replace desktop rendering or the separate UI journey. Do not present per-instance counters as durable ones.

A fresh independent reviewer now receives only this document and sanitized world outputs and attempts all 20 steps. The accepted coded result is ENG-105 items 1 and 2 Passed, with Clock fresh-render persistence Incomplete as a known limitation; a 10/10 runner is not a prerequisite for this review. Do not skip or force the Clock outcome—report what actually happens. Astra is not identifiable without `models.list` (#4955); the approved fallback is the org-default GPT-family model, variant low. Fix the doc/world if review reveals another gap and rerun; never edit a report into a pass.

Video tooling lives in `scripts/demo/video/`; actual PNGs/MP4s remain under `reports/demo/eng-105-2026-09-15/`. Use real isolated desktop footage, ≤3 minutes, excluding credentials and authorization URLs. Label API setup, still-frame assembly, instance resets, and incomplete steps. Videos illustrate the run; test evidence determines the verdict.
