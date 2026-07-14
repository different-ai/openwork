# OpenWork Connect Core

`@openwork/connect-core` is the portable runtime behind OpenWork Connect. It
keeps the hosted Den service and the local OpenWork server on one capability
contract and one two-tool MCP facade:

- `search_capabilities` discovers capabilities across registered sources.
- `execute_capability` invokes only an exact capability name returned by search.

Hosts own policy, credentials, persistence, and network access. Sources adapt
host-specific providers to this package's small search/execute interface. The
package has no database, web framework, Electron, or Den dependency, so the
same runtime can be embedded in cloud, desktop, server, and self-hosted builds.

## Host contract

Create one or more `ConnectCapabilitySource` adapters, compose them with
`createConnectRuntime`, and expose the result with `createConnectMcpServer` or
`registerConnectTools`. Source IDs and capability names must be stable. A host
must reject ambiguous ownership rather than selecting an implementation by
registration order.

This package is MIT licensed as part of the OpenWork repository.

## Portable package closure

`connect-runtime.manifest.json` is the packaging source of truth for the
runtime alias, MCP endpoint, fixed tool surface, and workspace packages that a
host must stage. The standalone server build and Electron build both consume
this manifest, so adding a runtime package is one package declaration rather
than a second desktop-specific implementation.

The runtime isolates source failures, applies bounded per-source search
deadlines, produces deterministic results, and rejects ambiguous execution
ownership. Hosts remain responsible for identity, credential vaults, egress
policy, and lifecycle/audit ports.
