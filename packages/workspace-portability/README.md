# `@openwork/workspace-portability`

## Purpose

This package owns the portable workspace-bundle vocabulary, safe relative-file
policy, and the warning/sanitization policy used when a workspace export may
contain secret-like configuration. It is useful without an OpenWork server and
can support local export review in a browser or other host.

## Supported realms

Realm-neutral. The package uses only supplied values and portable ECMAScript
APIs. Browser, Node, Bun, Electron, and Den hosts can consume it.

## Authority

None. Hosts retain authentication, filesystem roots and traversal, reads and
writes, archives, persistence, approvals, secret stores, and HTTP error mapping.

## Public exports

- `@openwork/workspace-portability` exposes bundle/import-preview contracts,
  portable path and file normalization, stable portability errors, export
  warning collection, and sensitive-value stripping.

```ts
import {
  collectWorkspaceExportWarnings,
  stripSensitiveWorkspaceExportData,
} from "@openwork/workspace-portability"

const warnings = collectWorkspaceExportWarnings(bundle)
const safe = stripSensitiveWorkspaceExportData(bundle)
```

`WorkspacePortabilityError` exposes the existing stable OpenWork error codes
`invalid_portable_file` and `invalid_portable_file_path`; a server adapter can
map those to its transport-specific error without the package importing HTTP.

## Boundaries

Secret detection is a conservative warning and sanitization policy, not proof
that an export is free of secrets. The package does not read a directory, follow
symlinks, select a workspace, create archives, parse HTTP requests, or apply an
import. Server adapters remain responsible for scoped filesystem safety and for
checking that state has not changed between preview and apply.

## Consumers

- OpenWork server export, import-preview, and filesystem adapters.
- OpenWork app client wire contracts.
- Packed external-consumer proof in the composable package gate.

## Stability

Internal and experimental. Current server fixtures and wire shapes define the
compatibility baseline while the larger import planner remains host-local.
