# Visual feature audit

The audit starts from `b439de768`: 24 registered flags, including 19 visible
product flows, four runtime-only switches, and one retained API whose old UI
was removed. Historical evidence is not assumed to represent the current UI.

## Evidence collection

The private review index contains 535 downloaded image files (517 distinct
contents) from 48 PRs, mapped against 259 related PRs. It preserves 421
latest-head advisory findings and their revision history. These are not 421
current defects: notes can repeat, describe removed UI, or measure unpainted
content. Private review-host sign-in, an unauthorized recording, expired or
quota-limited artifact inventories, and missing states remain explicitly
identified. No access restriction was bypassed.

Independent OW Anthropic Claude Opus 5.5 reviews cover all 19 visual flows
using representative images and applicable advisory notes. The private
reports list the images actually inspected; no all-image visual approval is
claimed. Raw PR material and historical images are not committed here.

## Reviewed repairs and human proof

| Surface | Repair | Journey |
| --- | --- | --- |
| Workbot settings | Portaled, collision-aware chooser; below-card pointer target; empty Default selection; save and Undo; read-only boundary | `den-workbot-settings.e2e.test.ts` |
| Workbot Calendar | Searchable and short model lists, keyboard dismissal, full recovery text, readable hours, stable toolbar, narrow forms | `workbot-calendar.e2e.test.ts`, `workbot-calendar-layout.e2e.test.ts` |
| Desktop Calendar | Readable initial hour, bounded creation/details, setup and blocked-state direction | `automation-calendar.e2e.test.ts` |
| Den text and search | Readable sentence-case labels, long workspace heading, clear palette empty state | `den-dashboard-activity.e2e.test.ts`, `den-command-palette.e2e.test.ts` |
| Shared save bars | Painted bottom inset and focus scroll clearance; Remove-only rows stay inline | `permissions-ui.e2e.test.ts`, `ai-gateway-cloud-sign-in.e2e.test.ts` |
| Gateway | Consistent provider filtering, loading/error/empty recovery, access-removal confirmation, searchable team assignment | `litellm-preview-flag.e2e.test.ts`, `ai-gateway-admin-provider.e2e.test.ts`, `ai-gateway-cloud-sign-in.e2e.test.ts`, `ai-gateway-spend-limits.e2e.test.ts` |
| Deployments | Explicit removal and cancel, consistent lanes, readable pending state, responsive consent | `managed-deployments.e2e.test.ts` |
| Permissions and members | Readable tabs and identity, usable narrow rows, real team-admin controls and denied identities | `permissions-ui.e2e.test.ts`, `team-organization-admin-ui.e2e.test.ts` |
| Analytics | Neutral zero-failure and plan-locked states, contextual reasons, compact filtering | `library-usage.e2e.test.ts`, `workflow-run-previews.e2e.test.ts` |
| Install links | Permission-specific clipboard failure without browser internals or false success | `den-download-openwork.e2e.test.ts` |
| Slack setup | Shared accessible settings controls and protected secret capture | `slack-assistant-setup.e2e.test.ts` |
| Workbot attachments | Portaled blocked hint, touch/keyboard dismissal, no picker or write | `workbot-first-use.e2e.test.ts` |
| Desktop upgrade | Optional notice below chrome, background continuity, explicit recovery, preserved backups/history/draft | `engine-v1-history-upgrade.e2e.test.ts` |
| Plugin sign-in | Compact approval heading with unchanged trusted client identity and consent | `opencode-plugin-sign-in.e2e.test.ts` |
| Shared headers | Compact headings, unchanged content/navigation and immediate rollback | `den-flat-page-headers.e2e.test.ts` |
| Audit history | Shared operation and capture settings rows, expandable changes, local timestamps, muted diagnostic disclosure | `audit-logs.e2e.test.ts` |

Journey files are under `evals/specs/`. Their named steps, open-control
screenshots, observed numbers, and negative identities form the review
report. Commands and verdicts belong to the exact tested head and CI evidence,
not a permanent claim in this document.

## Observation defects, not product changes

[PR #5852](https://github.com/different-ai/openwork/pull/5852) repairs layout
collection separately. Closed disclosures are excluded from painted text,
and wrapped text is measured per fragment. Geometry thresholds and the design
rubric are unchanged; real visible overlap and faint-text negative controls
remain detectable in `design-layout-visible-content.e2e.test.ts`.

A menu's bounding box does not prove that its options are painted. The
Workbot-settings witness checks the native pointer target **before** trusted
click lookup can automatically scroll an overflow-hidden ancestor. A dismissed
Base UI Select can retain hidden options for typeahead, so dismissal proof
observes painted absence and closed/focused state, then still checks stable
absence. Neither observation workaround weakens the actual UI claim.

## Rollout and deliberate retained behavior

- `denFlatPageHeaders` is newly declared **off**, on cloud and self-hosted,
  before its implementation. It changes only presentation; turning it off
  restores the existing header without changing objects, permissions,
  navigation, or running work. No production rollout is changed by this audit.
- `auditLogsCompact` is declared **off** on cloud and self-hosted. It changes
  only audit presentation, through Den's resolved feature map. Turning it off
  restores the previous operation table and capture settings; recording,
  retained evidence, filters, redaction and permission checks remain unchanged.
- Other repairs preserve their existing feature gates and server contracts.
- `Cloud default` is the organization's cloud-agent default, not the free
  `Auto` model. Explicit Automation model choices remain intact.
- Overlapping calendar items may intentionally use ellipsis while their
  accessible names and opened details retain the complete content.
- A connector is not called `Ready` merely because it requires no sign-in:
  readiness needs an actual verified, retained health observation.
- Stop is an intentional terminal outcome, not an error inviting an automatic
  restart. Earlier work and the conversation remain available.
- Synthetic fixture names are not outside identities. Technical audit data
  stays available behind explicit disclosures and requested change details.
- Native-scroll edge clipping after a person's deliberate scroll is distinct
  from an initially half-hidden hour label.

Design rules guiding the repairs: P3, P4, P5, P8, P9, P10, P11, S2, S3, C1,
C3, C5, C6, C7, V1, V2, V4, V5, and V6.
