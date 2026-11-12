# Den page consistency — review prototype

This is a **non-shipping design prototype**. The pull request stays draft until the behavioral changes below have rollout gates and broader interaction coverage. No API, database, permission policy or production rollout changes are included.

## The layout system

- Wide lists and analytics: centred 1200px outer column.
- Item pages, settings and forms: centred 760px measure, centred in the workspace **beside** the sidebar.
- Team and role pages: centred 860px measure; existing grouped-sidebar variant keeps its wider frame.
- Lists: 48px content plus a hairline; 32px identity tile; 13px name and 12px secondary line. Expanded or wrapped content may grow.
- Library, Connectors and Plugins: a bounded name/description lane followed by the sharing lane; the menu stays at the far edge. Grouping by kind stays specific to Library.
- Header and toolbar controls: 32px. Summaries and charts reuse the Automations card treatment.
- Connector settings and external-app setup use a shared disclosure. Lists and settings use flat sections rather than nested cards.

Shared implementation: `dashboard-styles.ts`, Computers row primitives, `ItemPage`, `ItemPanel`, `LibraryCompactRow`, `DisclosureSection`, and `TeamPageFrame`.

Design references: DESIGN.md P3 (progressive disclosure), P5 (reuse), P6 (density), S1 (flat surfaces), S2 (compact rows), S3 (disclosures).

## Review before merge

- [ ] Add off-by-default rollout gates for behavioral changes: hiding the Workflow Runs navigation tab, immediate audit filters, dirty-only Org settings saving/Discard, and the team-page Edit team entry point. These organization pages are not the platform `/admin` exemption.
- [ ] Exercise read-only/member permissions, settings persistence, failed pagination and long plugin directories; the prototype has browser checks, not complete release coverage.
- [ ] Resolve two different plugin-sharing editors (the main page versus Edit contents).
- [ ] Decide whether team pages should open on Role or Members; this prototype preserves the existing default and the existing `teamSettingsSidebar` flag.
- [ ] Keep or retire the old Workflow Runs address. It remains accessible and retains its tab when opened directly.
- [ ] Consider folding `gateway-rows.tsx` into the Computers row's `lead` interface.

The stored audit outcome "Unknown" is **not fixed** here. Investigation points to requested/served event aggregation; the backend remains untouched. Audit action display must not reinterpret unknown mutation attempts as reads.

## Evidence

`evals/proofs/den-page-consistency.proof.test.ts` uses an isolated synthetic organization to check compact rows, name filtering, a connector centred at 1920px, and a 390px boundary. It reuses the existing compact Library world and never calls a live connector.

The PR's screenshot attachment includes baseline and prototype views at the same viewport, plus wide-screen connector captures. All names/data in the screenshots are fictional seed fixtures.
