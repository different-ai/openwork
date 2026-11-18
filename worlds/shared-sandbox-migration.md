# Shared sandbox migration: preview-workbot

The first world moved onto the MIT sandbox layer is `preview-workbot`, on both
Freestyle and Daytona. Other world recipes keep their current transports.

- Freestyle previews use `@openwork/sandbox-freestyle` for create/run/files/delete.
  Preview policy remains in `packages/freestyle`: TTL, inline TLS rules, secret
  access files, sign-in routing, readiness and ownership checks. A narrow guest
  facade keeps older bootstrap recipes unchanged while this one host migrates.
- Daytona API-key previews use `@openwork/sandbox-daytona`. The existing Linux
  bootstrap recipes keep their command-runner edge, but lifecycle, process
  execution and private endpoints go through shared primitives. Snapshot inventory
  remains CLI-native; unsupported operations fail instead of falling back.
- Scoped `DAYTONA_API_KEY` + `DAYTONA_API_URL` has the same priority as the CLI.
  An active saved API-key profile also uses the SDK. Saved browser-login profiles
  retain the CLI transport for its token refresh logic; no tokens are copied into
  another client, and no login/profile is changed.
- An unacknowledged command result throws directly: the CLI retry wrapper cannot
  repeat a possibly executed side effect. Only a sandbox created by this driver
  can be deleted through its cleanup edge.
- The existing private-preview gates still require provider-confirmed private
  identity and port-bound signed hosts. This migration does not relax them.

Tests live with the eval packages: `hosts/src/sandbox-daytona.test.ts` covers
identity selection, ownership, shared execution and non-retry semantics;
`env/src/freestyle-sandbox-preview.test.ts` covers preserved TTL/TLS/access and
shared teardown. `pnpm world` remains the owner of a world's source, stage,
receipts, readiness and disposal.

This intentionally does not delete the old transports or fakes yet: desktop,
Windows, k3s, checkpoints and the other worlds still use them. Remove each path
when its last consumer migrates, not merely when an alternative exists.
