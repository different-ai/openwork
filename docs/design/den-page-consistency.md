# Den page consistency

A shared layout and list system for organization pages. It reuses the Computers row and Automations card rather than introducing another visual language.

## Layout

- Lists and analytics: centred 1200px outer column.
- Item pages, settings and forms: centred 760px measure, centred in the workspace **beside** the sidebar.
- Team and role pages: centred 860px measure; the existing grouped-sidebar variant keeps its wider frame.
- Lists: 48px content plus a hairline; 32px identity tile; 13px name and 12px secondary line. Expanded/wrapped content can grow.
- Library, Connectors and Plugins: bounded name/description lane followed by sharing state; the menu stays at the far edge. Grouping by kind stays specific to Library.
- Headers and toolbar controls: 32px. Summaries/charts reuse the Automations card treatment.
- Settings, sharing and detail sections are flat, not nested cards. Advanced connector settings use a shared disclosure.

Shared implementation: `dashboard-styles.ts`, Computers `ListRow`, the small `GatewayRow` adapter, `ItemPage`, `LibraryCompactRow`, `DisclosureSection` and `TeamPageFrame`.

Design references: P3 (progressive disclosure), P5 (reuse), P6 (density), S1 (flat surfaces), S2 (compact rows), S3 (disclosures). A bounded secondary line is retained for ambiguous item names (such as “data”) and identity details (email); full descriptions remain on the item's page.

## Behavior and rollback

The visual polish changes spacing, typography, icons and alignment without adding capabilities. Interaction changes are separately gated by [`denPageConsistency`](../features/den-page-consistency/README.md), **off by default on cloud and self-hosted**:

- Immediate audit filtering instead of Apply filters.
- Dirty-only settings Save/Discard instead of persistent Save settings.
- Edit team on the team page, opening the existing Members editor.
- Hiding the personal Workflow Runs tab from normal organization Analytics navigation.

Turning it off restores the earlier interactions. No data is migrated or deleted, no submitted save is cancelled, and settings drafts survive a same-organization refresh or flag change. Server authorization is unchanged.

## Deliberate boundaries

- Team pages still open on Role. The existing `teamSettingsSidebar` flag remains independent; changing the default section is not part of this work.
- Old Workflow Runs addresses and redirects keep working, with an active tab when opened directly. Individual workflow run history is untouched.
- The two plugin-sharing editors share rows, icons, add/remove controls and Base UI popovers, but not their selection/authorization models. The audience editor adds viewer access as a draft; the grant editor assigns viewer/editor roles to one target and retains invitation, creator and grant metadata. Flattening these into one authorization model would lose information.
- Stored audit outcomes are not rewritten. “Unknown” remains the server's value; unknown mutation attempts are not relabelled as reads.

## Verification

- `evals/proofs/den-page-consistency.proof.test.ts`: compact rows, working filter, centred 1920px connector, 390px boundary.
- `evals/proofs/den-page-interactions.proof.test.ts`: enabled owner, opted-out administrator and read-only teammate; discard, saved settings after reload, team-editor entry point, navigation and explicit/immediate audit filtering.
- `evals/proofs/den-plugin-directory.proof.test.ts`: 140 plugins, bounded rendering, failed cursor requests, explicit recovery, deep scrolling and filter reset.
- Colocated tests cover dirty normalization, refresh-safe drafts, invalid audit ranges, sharing controls, pagination boundaries and neutral audit action wording.

All fixtures use isolated synthetic organizations; connector calls use mocks. Feature screenshots live next to the rollout documentation. PR evidence contains the matched baseline/prototype captures and the final recorded proofs.
