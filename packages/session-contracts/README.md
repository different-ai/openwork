# `@openwork/session-contracts`

Internal, experimental, browser-safe contracts for OpenWork's
workspace-scoped session read API. The package owns serializable session,
message, todo, status, and snapshot shapes. It has no OpenCode SDK, server,
filesystem, process, persistence, or UI dependency.

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
