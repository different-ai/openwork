# New Plugin Arch API

This document is now the API index for the new plugin architecture.

## API docs

- `prds/new-plugin-arch/admin-api.md`
  - authenticated admin and direct-management APIs
- `prds/new-plugin-arch/delivery-api.md`
  - future client delivery and install-state APIs
- `prds/new-plugin-arch/webhooks-api.md`
  - public webhook ingress and async sync trigger shapes
- `prds/new-plugin-arch/GitHub-connector.md`
  - GitHub-specific connector flow, permissions, webhook behavior, and reconciliation model

## Shared principles

- expose logical resources, not raw tables;
- current-state endpoints should return projected current rows, not version-history duplicates;
- version/history endpoints should be explicit;
- delivery APIs should stay distinct from admin mutation APIs;
- public webhooks should stay distinct from authenticated APIs.

## Suggested split of responsibility

### Admin API

Use for:

- config object CRUD
- version history access
- plugin management
- access grants
- connector setup and mapping management
- sync-event inspection and retries

### Delivery API

Use for:

- listing accessible plugins for clients/users
- manifest retrieval
- download/install payloads
- reporting and comparing installed state

### Webhooks API

Use for:

- public connector ingress
- signature verification
- normalized webhook envelope handling
- async sync enqueue contracts

## Current recommendations

- keep one shared `config-objects` admin surface and add type-specific convenience endpoints where UI needs them;
- keep current-state search/list endpoints separate from version-history endpoints;
- treat plugin access management as a first-class API surface;
- keep connector setup, target, mapping, and sync APIs explicit;
- keep public webhook ingress separate from authenticated APIs.

## Current gaps

Still to decide:

- exact auth model for end-user delivery endpoints;
- rolling-latest vs release-snapshot delivery semantics;
- which type-specific validate/preview endpoints are public vs internal-only;
- whether bulk mutation endpoints are needed for large plugin or mapping edits.
