# `@openwork/extension-catalog`

## Purpose

This browser-safe package owns OpenWork's built-in extension manifests. It keeps
descriptive catalog data separate from executable host bindings and validates
all exported data with `@openwork/extension-contracts` at module construction.

## Supported realms

Realm-neutral. The catalog is immutable data and can be projected by browser,
Node, Electron, and Den hosts.

## Authority

None. Hosts choose which validated descriptors to expose and which executable
bindings to trust.

## Public exports

- `@openwork/extension-catalog` exposes the canonical built-in catalog.
- `@openwork/extension-catalog/den-marketplace` exposes the explicit legacy Den
  marketplace projection.

## Boundaries

This package owns validated built-in catalog data and compatibility projections,
not executable bindings, host registration, marketplace policy, persistence, or
installation.

## Compatibility projection

`BUILT_IN_OPENWORK_EXTENSION_MANIFESTS` is the canonical six-item app catalog.
The Den marketplace export is an explicit compatibility projection: it retains
the historical five-item public payload while catalog ownership converges. In
particular, Voice remains app-only until a separately reviewed distribution
decision opts it into Den; it is not accidentally omitted by duplicated data.
