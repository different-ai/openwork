# ENG-105 options and accepted verdict

**ENG-105 items 1 and 2: PASSED on OpenWork v0.18.46 source** (`a0d6bd1de8debf4f09d22b8538e124b2ff45b339`), not packaged-binary verification. C10 recorded nine Passed claim groups. Its runner correctly remains Failed, exit 1 / 0 passed tests / 1 failed / 0 skipped, because the additional Clock fresh-render persistence assertion exposed the known memory-store limitation. The assertion is retained.

Five options are listed below, within the six-option cap. No storage service, alternate authorization picker, or host-code fix was added.

| Option | Scope | State | Evidence / remaining work |
|---|---|---|---|
| A — managed dashboard + automatic member OAuth | Required ENG-105 user journey | Passed | Named sharing; distinct member calendars; identity-stable refresh with disclosed per-instance generation semantics. Independent D observed steps 1–19 Passed; step 20 exposed the same known limitation. |
| B — two-stage API setup | Portable configuration and cleanup | Incomplete | Tool implemented, 26 safety tests passed; bounded production connections-only apply/reapply/verify/cleanup passed. After-connect dashboard stage is fixture-proven, not claimed as a live production pass. |
| C — actual CDP film | Same-run presentation | Passed within approved 9/10 presentation scope | Final caption-v3 60-second PARTIAL film exported and verified. Required ENG-105 result leads; no all-tests-pass claim. |
| D — PNG + Remotion film | Same-run still-frame presentation | Passed within approved 9/10 presentation scope | Final caption-v3 54-second PARTIAL film exported and verified. Earlier partials remain immutable. |
| E — durable Clock persistence | Added check, not a required ENG-105 item | Incomplete — known limitation | Shared-mode in-memory store resets across Vercel instances. Persistent host or Blob/KV is a morning decision; neither was provisioned. |

## A: primary UI journey

Run `pnpm world up acme-demo-eng105 --detach` from the prepared release-based checkout and follow [the 20-step operator script](eng-105-dashboard-demo.md). Alex creates **Acme Day**, adds real MCP App references, and grants Jordan named access. Each member connects Calendar separately through its synthetic auto-approving authorization server. C10 proved different names, fingerprints and meeting sets, with identity stable across refreshes. Alex's generation increased within one process; Jordan's process change reset generation with a newer timestamp, explicitly allowed by the stateless demo contract. This proves the required host isolation/sharing behavior, not production identity assurance, single-use authorization codes, or distributed counter durability. **Passed for ENG-105 items 1 and 2.**

## B: portable API setup

Inject `DEN_API_URL`, `DEN_API_KEY` and a private persistent `DEMO_STATE_DIR`; run `bash scripts/demo/setup-eng105-den.sh --apply`. The first stage creates auto-running Home + Clocks and named sharing in **`<prefix>ENG105 API Demo`**. Expected Calendar HTTP 409 is retained as member-consent enforcement, not relabeled successful discovery. After the calling member clicks Connect, `--after-connect` appends Calendar only to the untouched owned dashboard. `--verify` reads state; `--teardown` removes only recorded created IDs. `--connections-only` leaves primary UI authoring untouched. This proves the explicitly tested API/configuration scope, not desktop isolation or UI navigation. Historical production proof used script `6567afa`; final two-stage behavior is fixture-tested. **Incomplete for live two-stage dashboard proof; bounded production connection provisioning/idempotence/cleanup Passed.**

## C and D: films

From `scripts/demo/video`, validate an actual manifest with `pnpm assemble --manifest <actual-manifest.json> --validate-only`, then render in a logged background process without `--validate-only`. C uses actual timestamped CDP frames; D uses actual PNGs through Remotion. Both require A/B media and matching release provenance; outputs are capped at three minutes. C10's same-run films lead with the observed required ENG-105 result, retain **PARTIAL (9/10)** labels, and show the Clock limitation. They do not substitute for coded test evidence. Strict complete-mode guards still require all ten claims and a passing runner; they were not relaxed. White-matte PNG transparency is disclosed, baked-in JPEG darkness is retained, and earlier partial runs are never mixed into a new result.

## E: Clock persistence limitation — no fix deployed tonight

The current provider allocates `MemoryPreferenceStore` in `server/vercel-entry.ts:15–17`; `server/store.ts:88–101` is only a process-local Map. Save and its native approval work, but fresh `show_world_clocks {}` may return six defaults after an instance switch. Reproduce with operator steps 18–20; record the result rather than retrying until a favorable instance appears or changing launch arguments. Fix choices are a persistent host such as Fly/Render (the existing file store needs persistent storage), or Vercel Blob/KV. **Those storage alternatives are not built.** No new service/store is authorized tonight, and no host defect is claimed for this limit.

## Released-host binding fix and deployment fork (b)

The shipped host drops app-visible tools without `ui.resourceUri` — **external fix applied** in canonical Clock source `0e0e70f32163687512c09e24ae68334a5a47dedd`: seven tools, four UI bindings, app-only visibility and write annotations preserved. Proposed host improvement only: treat same-server app-only tools as bound to the launching resource. No OpenWork product change was made. Native `save_preferences` confirmation remains required.

Fork **(b)** was selected after exact CLI error `Error: The specified scope does not exist` and original-project response projection `{"status":403,"error":"forbidden"}`. The approved fallback is **https://world-clocks-demo.vercel.app/mcp**, deployment `CPS8WYLdK6W3PLoFE5Qea1HUDkAF` under prologe. Initialize/tools/resource reads returned 200, with seven tools/four bindings. Only tonight's owned configuration changed. The original `world-clocks-six` deployment and real-org connector remain untouched. Rollback tag `pre-resource-binding` points to `fc86788f0aad5f9ee083f6fdca4a67c43929b74c`; legacy subtree code is aligned at `451d2d2cd39330b62286cbec7dc38947b2697508`.

## Morning actions — in priority order

1. **Guillaume: Connections → World Clocks (`emc_01m2gy1q…`) → URL `https://world-clocks-demo.vercel.app/mcp` → Refresh tools (7)**, then verify Edit/save. Alternatively Ben grants the ops token original `team_J0n…` access so the canonical fix can be deployed there. The demo agent did not edit that connector.
2. Decide visibility and organization transfer for three repositories: Acme Home public, Personal Calendar private, World Clock Dashboard local. Guillaume decides; `different-ai` transfer needs Ben. No public Calendar publication or org transfer occurred.
3. Choose whether Clock fresh-render persistence merits a persistent host or Blob/KV. The current limitation remains explicit.
4. Record the two DCR interoperability findings: the demo AS rejected released SDK metadata requesting `refresh_token`; separately its code-only response had a 687-character client ID exceeding Den's 512-character field. The provider now truthfully negotiates only code grants and returns a compact signed 205-character ID (`9051e3ca`). Do not claim the second issue caused the first logged rejection. No host fix was required.
5. Consider the app-only helper-binding host improvement above as a separate product task, not part of this demo PR.

Dropped forks: two-button identity picker, shared Calendar credentials, generated Workflow snapshots, another Daytona topology, and public Calendar publication. The independent reviewer uses the approved org-default GPT-family model with variant low because Astra cannot be identified without `models.list` (#4955); no obsolete local provider ID is reused.

## Morning decision — option 1 chosen; supersedes the Clock limitation above

**2026-09-15: Vercel private Blob selected and deployed. Existing demo checklist: 10/10 COMPLETE.** This resolves option E above without creating another user journey; persistent-host alternatives were not built because Blob passed the requested durable-storage proof.

- External app signed/DCO commit `786599f7ea1119d202904407931d54add8cbf053`; legacy subtree `fdf63090dbb79c15e9e806105eb8d35fbee79439`; rollback tag `pre-blob-store`. Private deterministic keys, overwrite enabled, uncached reads; Blob > file > memory. 110 tests passed; Betterleaks external diff 0.
- Production shared preferences survived a forced second Vercel deployment, with fresh `{}` returning `storeKind: blob`. Existing one-shot released-host spec then retained newly added Paris: exit 0, 1 passed/0 failed/0 skipped, all ten claim groups Passed on `2db17ef65`. [Published evidence](https://github.com/different-ai/openwork/pull/5017#issuecomment-5680351059).
- New C 48s / D 50s COMPLETE films use only `reports/demo/eng105-proof/2026-09-15T12-38-23.971Z/` captures, original finalized runner hash, and owner/media bindings. [Players and detailed receipts](https://github.com/different-ai/openwork/pull/5017#issuecomment-5680490215). Prior PARTIALs unchanged.
- Assembler-only compatibility patch `5a22a0bfaa06467b27c66d3e208e5ee74dac17bd` is signed/DCO and pushed. It handles passing assertion-only runners with unjudged supplementary PNGs using exact count consistency; 13 tooling tests/typecheck/lint pass. No journey spec, product source, runner or claim bytes changed; runtime proof remains bound to `2db17ef65`. Latest Warden review is Incomplete (missing OpenAI credentials), not clear.
- Existing scope limits remain: header Refresh, not desktop restart; no new Jordan Clock assertion; Calendar is synthetic with instance-local counters. Earlier independent D and setup outcomes remain historical, not relabeled.
- World ports 8790/3005 were stopped and verified free, then explicitly handed to `ses_f5af41ac6ffeA3cEsvzkvTE91T` for its authorized per-user Home proof. That lane owns boot/leave-alive; this Blob lane will not restart it. Audit handled copying COMPLETE films into the protected main checkout.
