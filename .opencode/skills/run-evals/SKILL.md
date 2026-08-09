---
name: run-evals
description: DEPRECATED legacy automation runner. Load only when a user explicitly asks to run an EXISTING evals/flows/*.flow file. New coverage uses run-tests.
---

# Legacy Eval Runner Compatibility

Use this guide only when the user names a flow that already exists in
`evals/flows/`. The directory is frozen.

For current verification, use `prove-a-pr` → `write-a-spec` → `run-tests` → `publish-evidence`.

- Refuse to create, scaffold, copy, rename, or modify a legacy flow.
- If the requested behavior has no existing flow, use `write-a-spec` and
  `run-tests`; new specs import `test` from `@openwork/testkit`.
- Manual browser work is debugging, not replacement verdict evidence.

List and run only the requested existing flow:

```bash
pnpm evals --list
pnpm evals --flow <existing-id> --cdp-url <electron-cdp-url>
```

Use `daytona-electron-test` only when the existing flow needs a Daytona app.
Report failures and obsolete coverage without changing the flow. See the
`fraimz` compatibility skill only when the user explicitly requests the legacy
demo-mode artifact.
