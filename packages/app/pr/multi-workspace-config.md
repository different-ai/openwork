---
title: Workspaces
description: Share settings across projects with minimal friction
---

## Summarize
Enable multiple workspace profiles with quick switching and safe config sharing. The experience should feel native to the current dashboard, sessions list, and onboarding flow.

---

## Define problem
Teams need separate workspace contexts while keeping a few trusted defaults consistent. Today, users duplicate setup steps and lose track of which config applies where.

---

## Set goals
- Add workspace profiles without disrupting existing single-workspace users
- Keep switching fast and visible from the dashboard and sessions list
- Allow config export/import with clear scope and safe defaults

---

## Set non-goals
- No cross-device sync in this phase
- No multi-user permissions or ACL management
- No changes to OpenCode runtime config precedence

---

## Describe personas
- Solo builder who toggles between client projects
- Team lead who shares a baseline setup across projects
- New user who wants a guided first-time flow

---

## Map UX flow
Onboarding: choose a starter workspace or import a shared config, then land on the dashboard. Show a simple selector next to the existing project entry.

Switching: use the dashboard workspace picker with search and recent items, then reload the sessions list for that workspace. Show a toast confirming the active context.

Sessions list: group sessions by active workspace with a small badge and reuse the current list layout. Provide a filter toggle to show all or current only.

---

## Define export/import
Scope: export workspace-level config, model defaults, and skill selection. Keep project-specific file paths relative when possible.

Exclusions: omit secrets, tokens, local cache, and device-specific paths. Skip any files flagged as private in config metadata.

Security: show a review screen before export, and confirm before import applies changes. Validate manifest schema and warn on unknown keys.

---

## List requirements
Functional: create, rename, delete, and switch workspace profiles. Export and import configs as a single archive with a manifest.

UX: fit within existing dashboard cards and onboarding panels. Keep the active workspace visible on sessions list and session detail.

---

## Specify data
Manifest: JSON with workspace name, version, createdAt, config scope, and file map. Include a checksum per file entry.

Archive: zip containing `manifest.json` plus normalized config files. Preserve relative paths and strip secrets on export.

---

## Assess risks
- Users might assume config syncs across devices
- Imports could overwrite local preferences unexpectedly
- Large configs may slow onboarding or switching

---

## Raise questions
- Should imports create a new workspace by default or merge into active
- How should we surface config precedence conflicts in UI
- Do we need a dry-run view for imports in v1

---

## Measure success
- 30% of active users create a second workspace
- 70% of imports complete without rollback
- Switching time stays under 1 second on median devices

---

## Plan rollout
Phase 1: local profiles with switching and sessions filtering. Phase 2: export and import with manifest validation and review.
