---
name: prd-conventions
description: PRD authoring conventions for OpenWork
---

## Rule (Always Use This)

All new PRDs for OpenWork must live at:

- `vendor/openwork/pr/<prd-name>.md`

Examples:

- `vendor/openwork/pr/onboarding-1.0.md`
- `vendor/openwork/pr/folder-workspaces-jit.md`

## Why

- Keeps PRDs discoverable and consistently named.
- Avoids bloating `MOTIVATIONS-PHILOSOPHY.md` with long, evolving drafts.
- Makes it easy to link a PR/branch to a single PRD doc.

## PRD Template (Recommended)

Use this structure:

- Summary
- Goals / Non-goals
- Definitions
- Guiding principles
- Current state / problem
- Proposal
- UX / flows
- Data / storage
- Migration
- Acceptance criteria
- Open questions

## Naming

- Prefer kebab-case.
- Include version when appropriate (e.g. `onboarding-1.0`).
- Keep names stable once a PR is opened.
