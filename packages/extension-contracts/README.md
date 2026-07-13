# `@openwork/extension-contracts`

## Purpose

Experimental, OpenWork-owned contracts for extension manifests. This package
owns the serializable descriptor vocabulary and stable validation result shapes.

## Supported realms

Realm-neutral. The package can be consumed from browser, Node, Electron, and
Den hosts without importing any host runtime.

## Authority

None. Validation operates on supplied values and performs no I/O or executable
loading.

## Public exports

- `@openwork/extension-contracts` exposes the complete contract surface.
- `@openwork/extension-contracts/schemas` exposes the Zod schemas.
- `@openwork/extension-contracts/selectors` exposes resource selectors.
- `@openwork/extension-contracts/validation` exposes stable validation results.

## Boundaries

The package owns serializable descriptors only: no UI bindings, filesystem
access, process state, persistence, Den policy, or vendor SDK types.

## Example

```ts
import {
  extensionResource,
  validateOpenWorkExtensionManifest,
} from "@openwork/extension-contracts"

const result = validateOpenWorkExtensionManifest(payload)
if (result.ok) {
  const mcp = extensionResource(result.value, "mcp")
}
```

## Contract guarantees

The v1 schema accepts the current app and Den manifest vocabulary, returns a
deeply frozen normalized copy, bounds identifiers/text/collections, and rejects
duplicate resource identities. Validation failures use an OpenWork-owned,
serializable error shape rather than exposing Zod errors across boundaries.
