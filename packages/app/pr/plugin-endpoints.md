---
title: Plugin config via API
description: Use /config for short-term plugin listing and add
---

## Set context
OpenWork manages plugins by editing `opencode.json`, but remote workspaces cannot read that file. OpenCode already exposes `/config` for reading and updating project config, so the short-term plan is to rely on `/config` for plugin listing and adds instead of introducing a new `/plugin` endpoint right away.

---

## Define goals
- List configured plugins for remote workspaces using existing `/config`
- Add plugins by updating the config API in project scope
- Keep behavior aligned with current config merge rules

---

## Call out non-goals
- No plugin status (loaded/failed) signal
- No plugin removal or update endpoints in this phase
- No automatic dependency resolution or npm install workflow
- No new `/plugin` endpoints in this phase
- No global scope add via API (requires new endpoint)

---

## Short-term API usage
GET `/config` returns the resolved config for the active workspace.

```json
{
  "plugin": ["opencode-wakatime", "file:///path/to/plugin.js"]
}
```

PATCH `/config` adds plugins by submitting the full plugin list.

```json
{
  "plugin": ["opencode-wakatime", "opencode-github"]
}
```

```json
{
  "plugin": ["opencode-wakatime", "opencode-github"]
}
```

---

## Shape data
The plugin list is the same array of string specifiers used in config (`config.plugin`).
OpenWork treats the config list as the source of truth for "installed" plugins.

---

## Persist config
Project scope uses existing `Config.update()` behavior, which writes `<workspace>/config.json` and disposes the instance.
Global scope updates are out of scope for this short-term plan.

---

## Edge cases
- `Config.update()` merges config but replaces arrays; clients must read/merge/dedupe the full plugin list before PATCH.
- Updating config writes `config.json`, even if the project uses `opencode.json` or `opencode.jsonc`.
- The server disposes the instance on update; clients should handle reconnects without a `reloadRequired` signal.

---

## Update SDK
Expose `config.get()` and `config.update()` in the SDK for remote plugin flows.

---

## Integrate UI
Use `GET /config` to populate the plugin list in remote mode.
Use `PATCH /config` with a read/merge/write flow when adding plugins.
Host/Tauri mode can keep using local `opencode.json` parsing.

---

## Related APIs
Skills already have a dedicated endpoint (`GET /skill`), which OpenWork uses for remote listing.

---

## Log events
Log `config.get` and `config.update` when plugin changes are requested.
Errors include file path, parse details, and API caller identity.

---

## Plan rollout
Document this as the short-term path for remote plugin support.
Revisit a dedicated `/plugin` endpoint after OpenWork validates the config-based flow.
