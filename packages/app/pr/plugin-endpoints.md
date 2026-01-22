---
title: Plugin endpoints
description: Expose listing and install endpoints for plugins
---

## Set context
OpenWork manages plugins by editing `opencode.json`, but OpenCode does not expose a list/add API yet. A minimal service makes plugin management consistent across the CLI, SDK, and OpenWork.

---

## Define goals
- Provide list and add endpoints for plugins
- Keep behavior aligned with `opencode.json` rules
- Support project scope, with optional global scope

---

## Call out non-goals
- No plugin removal or update endpoints in this phase
- No automatic dependency resolution or npm install workflow
- No UI changes beyond wiring existing surfaces

---

## Design API
GET `/plugin` returns the resolved plugin list for the active workspace.

```json
{
  "plugins": ["opencode-wakatime", "file:///path/to/plugin.js"]
}
```

POST `/plugin` adds a plugin to the requested scope (default: project) and returns the updated list.

```json
{
  "plugin": "opencode-wakatime",
  "scope": "global"
}
```

```json
{
  "plugins": ["opencode-wakatime"]
}
```

---

## Shape data
The plugin list is the same array of string specifiers used in config (`config.plugin`).
No derived metadata is returned in this minimal phase.

---

## Persist config
Project scope uses existing `Config.update()` behavior.
Global scope uses `Config.updateGlobal()`.

---

## Update SDK
Add `listPlugins()` and `addPlugin()` to the OpenCode SDK with typed payloads.

---

## Integrate UI
Wire the Skills tab to call GET on load and POST on add.

---

## Log events
Log `plugin.list` with scope and count, and `plugin.add` with name and scope.
Errors include file path, parse details, and API caller identity.

---

## Plan rollout
Ship behind a `plugins_api` feature flag in OpenCode first.
Enable by default after one release once OpenWork validates end-to-end flow.
