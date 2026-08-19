---
name: fraimz
description: DEPRECATED legacy flow compatibility. Load only when a user explicitly asks to run an EXISTING evals/flows/*.flow file. New coverage uses write-a-spec and run-tests.
---

# Legacy Fraimz Compatibility

This guide exists only to run a user-requested flow that is already present in
`evals/flows/`. The corpus is frozen.

For current verification, use `prove-a-pr` → `write-a-spec` → `run-tests` → `publish-evidence`.

## Hard boundary

- Refuse requests to create, scaffold, copy, rename, or modify a legacy flow.
- Do not use a legacy flow as coverage for new work.
- For any new or changed executable end-to-end coverage, switch to
  `write-a-spec` → `run-tests` → `diagnose-a-red-run` when failing, then
  `publish-evidence` for existing ambient test evidence.

## Run an existing flow

Confirm the requested ID already exists with `pnpm evals:legacy --list`, launch the app
if that existing flow requires it, then run:

```bash
pnpm evals:legacy:demo --flow <existing-id> --cdp-url <electron-cdp-url>
```

Report the legacy runner result honestly. If the flow itself is broken or no
longer represents the behavior, stop and report that limitation; do not repair
the flow. `evals/README.md` documents the frozen compatibility lane.
