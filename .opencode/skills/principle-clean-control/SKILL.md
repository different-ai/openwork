---
name: principle-clean-control
description: "Apply before calling a failure pre-existing, flaky, or fixed, or before trusting a suspected regression. Run the same command on a clean baseline (origin/dev worktree, previous release, known-bad build) and compare."
metadata:
  opencode/autoinvoke: "false"
  opencode/slash: "true"
---

# Clean Control

A result means something only next to a control run the same way.

**Why:** Memory and modified checkouts lie. "It was already broken" without a control is a guess that hides a regression.

- Pre-existing: the same command fails the same way in a clean `origin/dev` worktree, with equal tools, env, services and flags.
- Fixed: the spec is red on the base and green on the head.
- Regression suspected: a known-bad build must fail the check, or the check is not sensitive.
- A control that does not reproduce is not proof of flakiness. Repeat both sides first.
- Quote both sides: commands, SHAs, exit codes, matching failure text.
