# `@openwork/extension-contracts`

Internal, experimental, browser-safe contracts for OpenWork extension
manifests. This package owns serializable descriptors only: no UI bindings,
filesystem access, process state, persistence, Den policy, or vendor SDK types.

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

The v1 schema accepts the current app and Den manifest vocabulary, returns a
deeply frozen normalized copy, bounds identifiers/text/collections, and rejects
duplicate resource identities. Validation failures use an OpenWork-owned,
serializable error shape rather than exposing Zod errors across boundaries.
