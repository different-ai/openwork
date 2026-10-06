# AGENTS.md

OpenWork is a free, open-source desktop app (macOS, Windows, Linux) for doing
work with AI agents on your own files — an open-source alternative to Claude
Cowork and Codex, built on OpenCode, running any model from 50+ providers.
Desktop mode keeps files local; cloud is optional. Three surfaces live in this
repo:

* **Desktop app** (`apps/`, `packages/`) — local-first agent workspace: chat on
  files, skills, browser automation, scheduled automations, Anthropic-compatible
  plugins.
* **OpenWork MCP gateway** (`ee/apps/den-api`) — one URL
  (`api.openworklabs.com/mcp/agent`) that brings org-assigned skills, plugins,
  and connections (Google Workspace, Microsoft 365, MCPs) into Codex, Claude
  Code, Cursor, or any MCP client via `search_capabilities` /
  `execute_capability`.
* **OpenWork Den** (`ee/apps/den-*`) — the org control plane: provision
  inference, manage teams and access, set desktop policies, publish skills and
  plugins through marketplaces.

The app consumes OpenWork server surfaces (self-hosted or hosted) rather than
inventing parallel behavior. Anything OpenCode can do is available in OpenWork,
even before a dedicated UI exists.

## Confidentiality (hard rule — this repo is public)

Never let a branch name, commit, PR text, comment, fixture, or evidence identify
a customer, prospect, partner, or outside person; use internal ticket IDs, and
escalate any leak instead of rewriting history.

## Generated API contracts

After changing Den routes or their shared schemas, run `pnpm den:contract` and
include `packages/docs/openapi.json` and `packages/sdk/src/gen/**` in the same
commit. The command builds once and generates both outputs from one snapshot.
After merging/rebasing `dev`, regenerate rather than choosing ours/theirs for
conflicted generated files. Never hand-edit them or regenerate a Drizzle migration
snapshot to resolve an API conflict.

Optional: `pnpm hooks:install` enables a pre-commit hook that skips unrelated
commits and regenerates/stages only contract outputs for API changes. It refuses
unstaged/untracked contract inputs or outputs, so finish partial staging first.
Hooks never commit, push, or change CI/Warden policy; CI remains authoritative.

## Coding

* pnpm only, never npm/yarn. TypeScript: never `any`, typecasts, or `as` unless
  100% necessary or instructed.
* Prefer Tailwind, React, shadcn/ui (Base UI), TanStack Query, Zustand, Zod,
  Drizzle, Better-Auth. Reuse `@/components`; end users are non-technical.
* New feature or a change users would notice? Pick (or add) the module, then
  declare a flag scoped to it, off, in `packages/features/src/registry.ts`
  before writing the code; make it safe to turn off, then roll it out from
  `/admin`. Every flag belongs to one module; a new product area adds its
  module id in `packages/license-contracts` first. Follow
  `.opencode/skills/add-a-feature`.
* Any user-facing UI (desktop app, Den web, MCP Apps, artifact views) follows
  `DESIGN.md`: read it before designing, cite its rule ids in PRs, and attach
  screenshots of new UI. The optional
  `.warden/skills/design-spec-review` skill can review these rules locally.

