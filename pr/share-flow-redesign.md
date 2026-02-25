# Seamless Share Flow Redesign (Free + Org)

## Product direction

- Free/default sharing remains the baseline experience.
- Organization is an optional index and permission layer on top of the exact same share links.
- One bundle format works everywhere (direct link, share service page, org hub card).

## Core UX rules

1. Every shared link must be usable directly, even without org membership.
2. `Open in OpenWork` from the share service should default to creating a new worker.
3. Importing into the current worker remains available as a secondary action.
4. Organization does not replace sharing, it organizes and governs the same assets.

## Deep-link contract

Proposed URL pattern used by share page and org hub:

```
openwork://import-bundle?ow_bundle=<encoded-share-url>&ow_intent=new_worker&ow_source=<share_service|org_hub>&ow_org=<optional-org-id>&ow_label=<optional-template-name>
```

Supported intents:

- `ow_intent=new_worker` (default): create a fresh worker and import bundle into it.
- `ow_intent=import_current`: import bundle into currently active worker.

## UI wiring

### OpenWork app: Share modal

- Primary action: `Create share link`
- Visibility chip:
  - `Anyone with link` (default, free-friendly)
  - `Add to organization` (optional)
- Destination controls:
  - `Open in OpenWork -> New worker` (default recipient behavior)
  - `Import into current worker` (secondary)

### Share service page

- Primary CTA: `Open in OpenWork (new worker)`
- Secondary CTA: `Import into current worker`
- Optional CTA: `Add to organization library` (visible only for signed-in org users)

### Organization hub (web app)

- Library is a central index of the same share artifacts:
  - Search by team, tags, owner, recency.
  - Open card -> same share detail model + Open in OpenWork deep link.
- Org ACL controls discovery and publishing, not bundle compatibility.

## Flowchart set

- `pr/diagrams/share-flow-redesign/01-free-default-share.mmd`
- `pr/diagrams/share-flow-redesign/02-open-in-app-new-worker.mmd`
- `pr/diagrams/share-flow-redesign/03-org-library-overlay.mmd`
- `pr/diagrams/share-flow-redesign/04-remix-and-versioning.mmd`

Rendered PNGs:

- `evidence/share-flow-redesign/01-free-default-share.png`
- `evidence/share-flow-redesign/02-open-in-app-new-worker.png`
- `evidence/share-flow-redesign/03-org-library-overlay.png`
- `evidence/share-flow-redesign/04-remix-and-versioning.png`
- `evidence/share-flow-redesign/share-flow-overview.png` (single sheet with all four flows)

Video walkthrough:

- `evidence/share-flow-redesign/share-flow-walkthrough.mp4`

## Acceptance checklist

- Direct link share works with no org context.
- Share page opens deep link with `ow_intent=new_worker` by default.
- OpenWork app deep-link handler can branch by intent.
- New worker provisioning path reuses existing remote/local worker creation flow.
- Org hub card launch and direct share URL launch land in equivalent app import UX.
