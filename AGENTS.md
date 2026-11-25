# AGENTS.md

OpenWork is an open-source desktop app for doing work with AI agents on your
own files, built on OpenCode. This repo is public.

* `apps/`, `packages/`: the desktop app.
* `ee/apps/den-api`: the MCP gateway.
* `ee/apps/den-*`: Den, the org control plane.

## Rules

* **Confidentiality.** Never let a branch name, commit, PR text, comment,
  fixture, or evidence identify a customer, prospect, partner, or outside
  person, or expose internal ticket IDs. Escalate a leak instead of rewriting
  history.
* **Product controls.** Use a Capability for what an installation can run
  (`packages/managed-deployments/src/capabilities.ts`), Org Config for how an
  organization uses it (`ee/apps/den-api/src/config-blobs/areas/*.ts`), and a
  Preview for temporary user-visible rollouts (planned `previews.ts`, with an
  `owner` and `expiresOn`; use the existing flag registry until then). See
  `add-a-feature`. Do not add or document raw `DEN_*` product switches.
* **UI follows `DESIGN.md`.** Cite its rule ids in the PR and attach
  screenshots.
* **Generated contracts.** Never commit or hand-edit OpenAPI or
  `packages/sdk/src/gen/**`. Never regenerate a Drizzle migration snapshot to
  resolve a conflict.
* **Code.** pnpm only. Reuse `@/components`; end users are non-technical.
* **Fix the root cause.** A workaround you find is debt to remove, not a
  pattern to copy. Never write a comment or doc that justifies a shortcut.
* **Checks.** Run `pnpm check` before you say you are done. It is the
  required PR checks, and the pre-push hook runs it too.

## Prove it works

A change is done when it is proven on the real product, not when it compiles
(`verify-openwork`, `write-a-spec`, `run-tests`). Check UI headless:
`pnpm world up dev-app-web --detach -- --browser`, then `drive-desktop-cdp`.
Open a desktop window only when the user asks or the change needs the desktop
shell, and prefer `--daytona`.

## Keep this file small

Prose is the weakest guardrail. When an agent gets something wrong, make the
mistake impossible in code, or catch it with a lint rule, type, or test. Add a
line here or a skill only for judgment no check can encode, and delete it when
a check replaces it.
