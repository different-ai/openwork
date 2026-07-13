# `@openwork/contribution-registry`

A small, browser-safe registration kernel for explicit OpenWork composition
roots. It has no runtime dependencies and no global state.

The package indexes contributions, not application services. A host creates one
realm-local registry for a specific surface, explicitly registers descriptor and
binding pairs, and freezes assembly before constructing runtime values.

```ts
import {
  CONTRIBUTION_CONTRACT_VERSION,
  createContributionRegistry,
  type ContributionDescriptor,
} from "@openwork/contribution-registry"

interface ActionDescriptor extends ContributionDescriptor {
  readonly kind: "server-action"
}

const registry = createContributionRegistry<ActionDescriptor, HostPorts, Action>({
  supportedContractVersions: [CONTRIBUTION_CONTRACT_VERSION],
})

registry.register(
  {
    id: "google-workspace/email-send",
    kind: "server-action",
    contractVersion: CONTRIBUTION_CONTRACT_VERSION,
    provenance: { packageName: "@openwork/google-workspace" },
  },
  { status: "ready", create: (host) => createEmailAction(host) },
)

const assembly = registry.freeze()
if (assembly.status === "ready") {
  const action = registry.construct("google-workspace/email-send", hostPorts)
}
```

## Contract

- Descriptors are serializable metadata; executable factories live in separate
  bindings.
- Registration defensively clones and deeply freezes descriptor metadata. Cyclic
  values, `undefined`, functions, symbols, bigints, non-finite numbers,
  accessors, sparse arrays, and non-plain objects are rejected as
  `invalid-descriptor` data.
- Registration is mutable only during explicit assembly. `freeze()` is one-way
  and idempotent.
- Duplicate IDs, incompatible versions, malformed descriptors/bindings, missing
  requirements, and dependency cycles become structured diagnostics.
- Ordering respects requirements first, then numeric `order` (default `0`),
  then semantic ID.
- Disabled and unavailable entries remain visible without executing a factory.
- Lookup and construction return discriminated data for unknown IDs and factory
  failures.
- The registry does not own runtime disposal. Each host or constructed runtime
  keeps lifecycle ownership appropriate to its realm, request, or session.

Contribution IDs and requirement references must be non-empty, already
trimmed, and contain no whitespace. Separators such as `/`, `.`, `:`, and `-`
are accepted.
