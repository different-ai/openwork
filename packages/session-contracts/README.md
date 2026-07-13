# `@openwork/session-contracts`

## Purpose

Experimental, OpenWork-owned contracts for the workspace-scoped session read
API. The package owns serializable session, message, todo, status, event, and
snapshot shapes.

## Supported realms

Realm-neutral. Browser, Node, Electron, and Den consumers share the same wire
vocabulary without importing a host or engine runtime.

## Authority

None. Hosts and adapters retain networking, engine, persistence, authorization,
and event-stream ownership.

## Public exports

- `@openwork/session-contracts` exposes the complete read-contract surface.
- `@openwork/session-contracts/schemas` exposes the runtime schemas.
- `@openwork/session-contracts/types` exposes semantic read-model types.
- `@openwork/session-contracts/validation` exposes stable validation results.

## Boundaries

The package has no OpenCode SDK, server, filesystem, process, persistence, or UI
dependency. It defines the portable boundary; adapters retain authority and
engine compatibility behavior.

## Compatibility guarantees

The runtime schemas deliberately preserve the server's existing compatibility
boundary: they validate the stable minimum fields, pass through additional
engine fields, and return normalized copies. Validation failures expose a
stable OpenWork-owned error and issue shape instead of leaking Zod across the
adapter boundary.

`compatibilityIssues` is a temporary, deeply cloned and frozen copy of the raw
Zod v4 issue shape. The server strangler adapter uses it to keep its existing
`ApiError.details.issues` wire response byte-compatible. New package consumers
must use normalized `issues`; the compatibility field can disappear after the
legacy server response is versioned or retired.

The semantic types preserve the current remote API surface so app consumers
can migrate away from engine-owned types without changing the wire response.
