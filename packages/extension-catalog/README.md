# `@openwork/extension-catalog`

This browser-safe package owns OpenWork's built-in extension manifests. It keeps
descriptive catalog data separate from executable host bindings and validates
all exported data with `@openwork/extension-contracts` at module construction.

`BUILT_IN_OPENWORK_EXTENSION_MANIFESTS` is the canonical six-item app catalog.
The Den marketplace export is an explicit compatibility projection: it retains
the historical five-item public payload while catalog ownership converges. In
particular, Voice remains app-only until a separately reviewed distribution
decision opts it into Den; it is not accidentally omitted by duplicated data.
