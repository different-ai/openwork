# `@openwork/session-groups`

## Purpose

This package owns OpenWork's portable session-group state, deterministic state
transitions, and event wire vocabulary. The server persistence adapter, HTTP
routes, app optimistic-sync adapter, and React UI all consume this one model.

## Supported realms

The package is runtime-neutral and can be imported by browsers, Node, Bun,
Electron, and test consumers. It has no runtime dependencies or ambient global
requirements.

## Authority

None. Hosts own clocks, random ID generation, persistence, HTTP authentication,
event retention, local storage, and UI synchronization.

## Public exports

The root export provides `SessionGroupState`, command and event contracts,
`normalizeSessionGroupState`, and `applySessionGroupCommand`.

```ts
import { applySessionGroupCommand } from "@openwork/session-groups"

const result = applySessionGroupCommand(current, {
  type: "assign",
  sessionId: "ses_1",
  groupId: "grp_focus",
})
```

Every transition returns a fresh normalized state. ID generation is
deliberately absent: the calling host must supply the ID for a create command.

## Consumers

- OpenWork server SQLite/event and HTTP adapters.
- OpenWork app client wire types and optimistic Zustand adapter.
- Packed external-consumer proof in the composable architecture gate.

## Boundaries

This package does not own SQLite, React, Zustand, local storage, fetch, routes,
authorization, OpenCode sessions, or event delivery.

## Stability

Internal and experimental. The contract is characterized against the current
server routes and app store before any future public release.
