---
name: forge-onboard
description: Use when onboarding a user to the Forge workflow with a guided, end-to-end change cycle.
---

# Forge Onboard

## Overview

Guide the user through a full Forge change cycle with real work and light narration.

**Core principle:** EXPLAIN -> DO -> SHOW -> PAUSE at key transitions.

## Preflight

- Run forge-preflight
- If `forge/` does not exist, create the Forge skeleton before continuing

## Phase 1: Welcome

Explain the cycle and set expectations (small task, 15-30 minutes).

## Phase 2: Task Selection

- Scan codebase for small improvements (TODOs, missing tests, error handling)
- Present 3-4 options with size/scope
- If user picks a large task, offer a smaller slice

## Phase 3: Explore

- Briefly explore relevant files
- Use a small ASCII diagram if helpful
- Pause for user acknowledgment

## Phase 4: Create the Track

- Choose a kebab-case change name
- Create `forge/tracks/<change>/`
- Show expected artifact locations

## Phase 5: Intent

- Draft `intent.md` (why, scope, success)
- Pause for approval, then write it

## Phase 6: Contracts (Delta)

- Create `forge/tracks/<change>/contracts/<domain>/contract.md`
- Use ADDED/MODIFIED/REMOVED sections
- Pause for approval

## Phase 7: Design

- Draft `design.md` with key decisions and data flow
- Pause for approval

## Phase 8: Tasks

- Create `tasks.md` with checkboxed steps
- Keep tasks small and ordered
- Pause before implementation

## Phase 9: Implementation

- Follow tasks, mark complete as done
- Keep narration light

## Phase 10: Verify

- Summarize evidence (tests/builds)

## Phase 11: Archive

- Run forge-archive and show archive location

## Guardrails

- Keep scope small
- Do not skip artifacts
- Pause at each phase transition
- If user wants to stop, show how to resume later
