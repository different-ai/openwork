# Composable OpenWork experiment

Status: end-to-end experiment complete; architecture proposed, not adopted
Branch: `experiment/composable-openwork`
Base: `different-ai/openwork@316b996ca45de0bc03f2c4880417f195eb71be7d`
Started: 2026-07-13

## Purpose

This branch tests whether OpenWork can make feature boundaries obvious without
changing the product users already have. It borrows the strongest pattern from
`@openwork/enterprise-mcp-client`: a capability owns a small contract and
lifecycle, host-specific policy arrives through required ports, adapters live at
the edge, construction happens in one explicit composition root, and migration
keeps a tested rollback path.

The hypothesis is broader than MCP:

> A feature should be independently understandable, testable, replaceable, and
> removable when it owns a cohesive contract and is registered explicitly into
> a realm-specific host.

This is intentionally an experiment, not adoption of the draft extension
platform plan. It produces code and measurements that can validate or reject
that plan. Marketplace distribution, arbitrary third-party code execution,
sandbox selection, stable public SDK promises, and final naming remain outside
this experiment.

## What success means

The experiment is successful when all of the following are true:

1. A browser-safe canonical extension descriptor is validated once and consumed
   by both the app and a server or Den adapter.
2. At least two different surface families use explicit, realm-local
   contribution registries without a global service locator.
3. One existing first-party feature reaches users only through its contribution
   contract and can be omitted at assembly time without preventing the host from
   booting.
4. Adding a representative second contribution requires its implementation,
   one assembly-list edit, and tests—not parallel label, icon, route, and
   dispatch switches.
5. Existing routes, actions, settings behavior, IPC shapes, persisted data, and
   trust boundaries remain compatible.
6. Package, app, server, and end-to-end proofs are green, and the architecture
   metrics improve from the pinned baseline.
7. Stale code is deleted only after reachability, packaging, and runtime proof;
   every removal is recorded with evidence and rollback.

## Architectural rules under test

- **Contracts point inward.** A capability contract uses OpenWork-owned values,
  not host stores, environment parsing, database rows, React shell state, or
  vendor SDK types.
- **Descriptors are data.** Serializable identity and capability metadata stay
  separate from trusted executable bindings.
- **Hosts keep authority.** Authentication, approvals, tenant scope, secrets,
  filesystem roots, network egress, persistence, and process ownership remain
  enforced by the realm that already owns them.
- **Composition is explicit.** App, server, desktop, orchestrator, and Den each
  assemble the contributions they trust. There is no process-wide dependency
  container and no import-time registration.
- **Registries index contributions, not services.** Business code receives
  narrow ports directly; it does not pull arbitrary dependencies from a
  registry.
- **Lifecycles are visible.** Construction, availability, startup failure,
  cancellation, reload, and disposal are contract decisions, not incidental
  cleanup.
- **Migration is additive.** Characterize the old path, introduce the contract,
  adapt the current implementation, select it at one root, prove parity, and
  remove the compatibility path only when its deletion condition is met.
- **Packages earn their boundary.** A workspace package must own a coherent
  behavior or cross-realm contract, have a small export surface, build what it
  exports, and pass an isolated consumer test.

## Realm model

One universal runtime would incorrectly merge browser, Electron, Bun/Node, Den,
and external-provider lifecycles. The shared grammar is deliberately smaller:

```text
validated descriptor contracts
              ^
              |
realm-specific contribution contracts and host ports
              ^
              |
feature implementations and platform adapters
              ^
              |
explicit app / server / desktop / orchestrator / Den composition roots
```

The concrete contribution kinds stay separate: settings surfaces, commands,
server actions, HTTP routes, desktop commands, engine adapters, MCP clients,
capability sources, background jobs, and process sidecars do not share one
mega-interface.

## Working method

Each stage is a coherent commit with its own proof and rollback note. The draft
pull request description is the live stage report. Runtime changes do not share
a commit with unrelated stale-code deletion, package moves, protocol changes,
or UI redesign.

See [RESULTS.md](./RESULTS.md) for the verdict, measurements, proofs, and known
exceptions; [BASELINE.md](./BASELINE.md) for the pinned starting evidence;
[PLAN.md](./PLAN.md) for the staged redesign; and
[STALE-CODE-LEDGER.md](./STALE-CODE-LEDGER.md) for deletion evidence.
