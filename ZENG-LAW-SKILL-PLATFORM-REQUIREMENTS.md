# Zeng Law Skill Platform Requirements

Date: 2026-03-27

## Goal

Translate the requested feature set into:

- the new private backend API responsibilities
- the exact change areas inside the current Cowork/OpenWork-style repository
- the AWS work needed to run it

## Recommended Architecture

- Keep `apps/server` as the execution/control API consumed by the OpenWork client.
- Use a private law-firm control plane for identity, org/team permissions, protected skill registry, versioning, audit logs, and admin workflows.
- The fastest path is to extend `ee/apps/den-controller` and `ee/apps/den-web` instead of inventing a second auth/control-plane stack from scratch.
- Treat protected law-firm skills as centrally managed assets, not as normal `.opencode/skills/*/SKILL.md` files that every client can read.

## Important Constraints

### 1. True skill secrecy and employee-local execution are in tension

If a protected skill runs on a junior employee's local machine, UI hiding plus file encryption only protects against casual inspection and plaintext at rest. It does not guarantee that a determined local user can never extract the prompt.

If "employees must never be able to get the skill prompt" is a hard requirement, protected skills should execute on a trusted remote runtime or be injected server-side into a protected worker.

### 2. Browser-only local-folder access is limited

A normal web page cannot access arbitrary local folders the same way the desktop/Tauri app can.

For "Claude-like local folder input + output without uploads", you need one of:

- the existing desktop/Tauri flow
- browser File System Access API with explicit folder grant
- a local helper / host connection
- a remote workspace sync or mounted worker volume

## Current Repo Baseline To Reuse

- `apps/app`: Claude/Cowork-like task UI, sessions, skills page, workspace picker.
- `apps/server`: workspace APIs, skill CRUD/export/import, tokens, reload events.
- `apps/desktop`: local folder access, native skill file read/write, desktop bridge.
- `ee/apps/den-controller`: auth/session control plane, org/team data model, worker provisioning.
- `ee/apps/den-web`: hosted auth/dashboard/admin shell.

## Current Status Update

This status update reflects both:

- the current baseline in `/Users/charlie/github.com/cowork-zeng-law-group`
- the protected-skill implementation work already completed in `/Users/charlie/github.com/cowork-zeng-law-group-wt-h1b-protected-skill`

Current active implementation slice for the first protected skill (`h1b-employee-docs-review`):

- `FR-05` metadata-only catalog
- `FR-06` no view/copy/share/export of protected body
- `FR-07` protected skill cannot be edited through the normal employee path
- `FR-11` first create/update packaging flow for Zeng
- `FR-13` protected skill execution path
- `FR-14` encrypted protected-skill bundle plus desktop decryption
- `FR-19` export/share hardening

Implemented or in progress now:

- The first protected repo skill exists as an encrypted bundle plus manifest.
- The skills page shows metadata for the protected skill instead of opening the raw body.
- The desktop app can resolve `/h1b-employee-docs-review` and inject the protected content at runtime without showing the prompt in the normal UI.
- Normal read, edit, replace, remove, and share flows are blocked for the protected skill in the current desktop-first implementation.
- The local repack/update workflow is documented and usable for this first skill.
- The protected-skill packer now updates manifest metadata automatically, including `version`, `publishedAt`, and `checksum`.
- Local server audit logs now record skill listing, normal skill view, and protected-skill view denials.
- Local verification now works for desktop build, server build, and Docker dev stack.

Still missing from the full platform design:

- Real admin identity and authorization for "only Zeng/admin can create/update/publish"
- Team-grant enforcement and team isolation
- Central DB-backed protected skill registry, publish flow, rollback, and full version history
- Hosted/browser execution parity for protected skills
- Audit logging for denied view/copy/export attempts
- AWS/Cognito production auth, deployment, monitoring, and IP restriction work

## Comprehensive Functional Requirements

Status semantics:

- `✓` = implemented in the current repo in a usable way
- `△` = partially implemented or in progress in the protected-skill worktree; not yet complete platform-wide
- `X` = not implemented yet

| ID | Status | Functional requirement | Done when | Code for the newly created backend (my backend API) | Code that needs to be written within the existing Cowork repository | Features and tasks that need to be handled on AWS |
| --- | --- | --- | --- | --- | --- | --- |
| FR-01 | X | Passwordless email login with OTP/passcode | User enters email, receives a 6-digit code by email, enters the code, and logs in without any password field. | Add `request-code`, `verify-code`, resend, session issuance, logout, and rate-limit endpoints. Verify Cognito-issued tokens or exchange Cognito auth into your app session. | Replace the current password/social-first flow in `ee/apps/den-web/app/(den)/_components/auth-screen.tsx` and `ee/apps/den-web/app/(den)/_providers/den-flow-provider.tsx`. Remove password as the default login path. | Create Cognito user pool/app client, configure email delivery, connect SES/domain identity, add CloudWatch alarms for auth failures and send-rate issues. |
| FR-02 | ✓ | Hosted session and desktop handoff | A user can log in on the web and continue into the desktop/OpenWork client without a second login flow. | Add short-lived desktop handoff/session exchange endpoints and bearer/session validation rules. | Update `ee/apps/den-controller/src/http/desktop-auth.ts`, plus any deep-link or connect flow touched by `apps/app/src/app/lib/deep-link-bridge.ts` and remote connect UI. | Configure Cognito callback URLs, HTTPS/TLS, and any ALB/API Gateway/App Runner routing needed for secure redirects. |
| FR-03 | X | Organization, team, and member management | Zeng can invite users, place them into teams, and every session runs with org/team context. | Reuse the existing org/team/member model in `ee/apps/den-controller`; add any missing CRUD or invite APIs and make active org/team part of every session. | Extend the Den admin/dashboard UI in `ee/apps/den-web` to manage members and teams cleanly. | Run the relational database that backs org/team membership; add migrations, backups, and restore procedures. |
| FR-04 | X | Fine-grained skill authorization | Zeng can control who can list, use, edit, publish, or delete each skill. | Add tables such as `skill`, `skill_version`, `skill_grant`, and `skill_action_policy`, or equivalent. Enforce checks on list, use, update, export, and publish operations. | Add admin UI for skill-level grants and wire org/team context into app requests. | Apply DB migrations, indexes, and optionally caching for grant lookups. |
| FR-05 | △ | Skill catalog is metadata-only for employees | Employees can see skill name and function, but never the internal prompt or full markdown body. | Return metadata-only responses for non-admin users: localized name, description, team, version, tags, trigger summary, protection mode. Only privileged runtime paths may request body content. | Change `apps/app/src/app/pages/skills.tsx`, `apps/app/src/app/context/extensions.ts`, and `apps/app/src/app/lib/openwork-server.ts` so protected skills no longer fetch or display `content`. | No special AWS service beyond hosting/cache; keep this enforcement server-side. |
| FR-06 | △ | Employees cannot view, copy, export, or inspect protected skill content | Clicking view/copy/share/export is blocked and logged; direct API calls to fetch protected content are denied. | Deny raw-content routes to non-admin users. Add audit records for denied attempts. Redact protected skills from export/share endpoints. | Disable or gray out `View`, `Share`, `Copy`, `Reveal`, and similar flows in the app. Remove protected content leaks from `apps/server/src/server.ts`, `apps/server/src/share-bundles.ts`, `apps/share/*`, `apps/app/src/app/pages/session.tsx`, and `apps/app/src/app/pages/dashboard.tsx`. | Optionally add WAF rules and centralized log retention for repeated denied-access attempts. |
| FR-07 | △ | Only Zeng or authorized admins can create/update protected skills | Employees cannot modify protected skills; Zeng can create, edit, publish, and roll back versions. | Add admin-only create/update/publish/rollback APIs and ownership checks. | Build an admin skill-management surface in `ee/apps/den-web` or a protected admin area in `apps/app`; disable save/edit for non-admin users. | Use Cognito groups/claims or your own role mapping so admin-only routes are enforced at the edge and in app code. |
| FR-08 | X | Team isolation | Team A cannot see or use Team B skills. | Filter catalog results by org/team grants and re-check authorization at run time. | Hide cross-team skills in the UI and treat bookmarked direct URLs as forbidden. | Keep grant data in DB and ensure indexes support team-scoped lookups. |
| FR-09 | X | Bilingual skill metadata | Employees can browse skills in Chinese and English, with locale fallback. | Store localized fields for name, description, and usage copy; support search across both languages. | Render localized metadata in `apps/app` and `ee/apps/den-web`; follow existing locale plumbing. | Store localized metadata in DB and keep seed/migration scripts in sync. |
| FR-10 | △ | Central protected skill storage and versioning | Each skill has a version history, publish state, checksum, and rollback path. | Store metadata in DB and versioned source bodies in secure object storage. Maintain `latest_version_id` or equivalent plus publish timestamps and checksums. | Stop treating protected skills as ad hoc editable markdown files. The Cowork repo should consume manifests and versions, not employee-readable source bodies. | Use S3 with versioning plus KMS encryption; add lifecycle policies and backup rules. |
| FR-11 | △ | Easy create/update flow for Zeng | Zeng can name a new skill in the UI, upload a skill doc, publish an update, and the team sees the new version on next use. | Add upload/create-version/publish endpoints with validation and latest-version switching. | Add a simple admin form and version list in `ee/apps/den-web`; optionally reuse the app shell if you want a single UI surface. | Use S3 direct upload or presigned upload flow; handle KMS permissions and cache invalidation if needed. |
| FR-12 | △ | Latest skill version is used on next invocation | Team users do not keep using stale versions after Zeng publishes an update. | Provide a skill manifest endpoint with version hash/ETag and a runtime fetch path that always resolves the latest published version. | Reuse the existing reload-event concept in `apps/server` where helpful, but change skill execution to resolve by skill ID/version manifest instead of local markdown body. | Tune cache TTLs and invalidation so version propagation is fast but cheap. |
| FR-13 | △ | Protected skill execution path that does not expose raw prompts to employees | Employees can run protected skills and see results, but the raw prompt body is only materialized inside a trusted runtime. | Add a runtime-only fetch/execute context API so a trusted worker can obtain decrypted skill content after authz. Prefer remote worker/server-side injection for protected skills. | Modify `apps/server` and the client-side skill selection flow so protected skills are referenced by ID/manifest, not by directly reading `SKILL.md` into the UI. | Run a trusted compute surface for protected execution, such as ECS/Fargate, App Runner, or another controlled worker model. |
| FR-14 | △ | Local encryption for cached skill files plus decryption layer | Any locally cached protected skill asset is encrypted at rest, decrypted only when needed, and never left exposed in plain text longer than necessary. | Issue encrypted blobs or envelope metadata; avoid returning raw plaintext to untrusted clients whenever possible. | Add encrypted cache handling in `apps/desktop` and/or `apps/server`; do not keep protected skills as plain `.opencode/skills/.../SKILL.md` on employee machines if secrecy matters. Use OS keychain/secure storage where possible. | Use KMS for envelope encryption if the backend controls key wrapping; manage rotation and least-privilege access. |
| FR-15 | ✓ | Claude-like project/local-folder workflow without manual uploads | User selects a project folder, works in that context, and outputs land in that project without repeated file upload flows. | For hosted mode, add workspace registration/mount semantics or a local-helper protocol instead of generic upload APIs. | Reuse the existing workspace picker and local folder flow in `apps/app/src/app/context/workspace.ts` and desktop commands. If you need browser-only mode, add explicit folder grant or local-bridge logic. | If remote workers are used, provide mounted workspace storage such as EFS/EBS or a controlled sync path rather than one-off file uploads. |
| FR-16 | ✓ | Chat history and new-task persistence | All conversations are retained like Claude; users can start a new task while keeping prior history. | Add hosted user/workspace/session indexing if you want central history management; otherwise store metadata that points to worker-local OpenCode history. | Most of this already exists in the repo through sessions and OpenCode DB access; the main change is user/org scoping in the hosted surfaces. | Backup worker volumes or central metadata, depending on where history is persisted. |
| FR-17 | X | Skills web pages only work from law-firm IPs, except for Zeng | Off-office access to skills pages/admin APIs is blocked unless the user is Zeng or another explicitly exempt admin. | Add IP-policy middleware plus authenticated user-based bypass logic. Return clear forbidden reasons. | Add blocked-state UI and route guards in `ee/apps/den-web` and any app routes that expose skill management. | Create WAF IP sets or ALB/CloudFront rules for office CIDRs. Because Zeng needs an exception, final bypass should remain in app/API logic rather than WAF alone. |
| FR-18 | △ | Audit trail and compliance logging | Every login, OTP verification, skill listing, skill use, denied view attempt, publish, and grant change is logged. | Add append-only audit tables/endpoints and event types for auth, skill access, denied actions, admin changes, and publish events. | Add an admin audit UI and user-facing error states that do not leak sensitive data. | Use CloudWatch logs, log retention policies, and optional S3 archival for longer-term audit retention. |
| FR-19 | △ | Share/export hardening | Protected skills cannot be published as public links or included in workspace export bundles. | Add a `protection_mode` or `share_policy` check on every export/share endpoint; protected skills must be excluded or redacted. | Update `apps/server/src/server.ts` export paths, `apps/server/src/share-bundles.ts`, `apps/share/*`, and any share buttons in session/dashboard/skills pages so protected skills never leave as bundles. | If the public share service remains enabled for non-protected assets, keep protected bundle classes disabled at origin and edge. |
| FR-20 | X | AWS deployment within roughly $100/month | The initial production setup can run auth, API, admin UI, storage, email, and modest usage within the target budget. | Add an AWS deployment path for the control plane and, if needed, an AWS provisioner option in `ee/apps/den-controller/src/workers/provisioner.ts`. | Update env/config docs and any provider abstraction that currently assumes Render/Daytona-only hosted workers. | Likely baseline: Cognito, SES, one small API/web runtime, one small MySQL-compatible DB, S3, KMS, CloudWatch, WAF. Always-on remote worker fleets are the biggest budget risk. |
| FR-21 | X | Monitoring, backups, restore, and ops runbook | You have health checks, alarms, automated backups, and a restore plan before rolling out to employees. | Add health endpoints, migration commands, backup verification steps, and operational runbooks. | Reuse existing health surfaces where available and add admin diagnostics if needed. | Configure CloudWatch alarms, DB backups, S3 lifecycle/replication as needed, KMS key policies, and secret rotation. |

## Suggested New Backend API Surface

If you keep this inside the current repo, the natural home is `ee/apps/den-controller`.

- `POST /auth/email/request-code`
- `POST /auth/email/verify-code`
- `POST /auth/logout`
- `GET /me`
- `GET /orgs/:orgId/teams`
- `POST /orgs/:orgId/invitations`
- `GET /skills`
  - metadata only for normal employees
- `GET /skills/:skillId`
  - metadata only unless admin
- `POST /skills`
  - admin only
- `POST /skills/:skillId/versions`
  - admin only
- `POST /skills/:skillId/publish`
  - admin only
- `POST /skills/:skillId/grants`
  - admin only
- `POST /skills/:skillId/runtime-context`
  - trusted runtime only
- `GET /audit`
  - admin only
- `GET /health`

## Highest-Impact Current Repo Files

These are the main places I would expect to touch first.

- `ee/apps/den-web/app/(den)/_components/auth-screen.tsx`
  - Replace password/social-first UX with email-only OTP login.
- `ee/apps/den-web/app/(den)/_providers/den-flow-provider.tsx`
  - Rewrite auth state, OTP request/verify, and desktop handoff integration.
- `ee/apps/den-controller/src/auth.ts`
  - Replace or bridge the current Better Auth flow to Cognito-backed passwordless auth.
- `ee/apps/den-controller/src/http/desktop-auth.ts`
  - Keep web-to-desktop session handoff working after auth changes.
- `ee/apps/den-controller/src/orgs.ts`
  - Extend the existing org/team model for skill grants and admin policy.
- `ee/apps/den-controller/src/organization-access.ts`
  - Add new skill-related permission statements/actions.
- `ee/packages/den-db/src/schema.ts`
  - Add skill, skill version, grant, and audit tables.
- `apps/server/src/server.ts`
  - Redact protected skill content, harden export/share flows, and add a protected runtime path.
- `apps/server/src/skills.ts`
  - Split metadata from body access and stop assuming every skill is a plain markdown file.
- `apps/server/src/share-bundles.ts`
  - Prevent protected skill publishing.
- `apps/app/src/app/pages/skills.tsx`
  - Move to metadata-only employee view, admin-only edit/publish actions.
- `apps/app/src/app/context/extensions.ts`
  - Remove normal employee `readSkill`/`saveSkill` behavior for protected skills.
- `apps/app/src/app/lib/openwork-server.ts`
  - Change client contracts from `content`-based skill access to metadata/manifests/runtime requests.
- `apps/app/src/app/pages/session.tsx`
  - Remove protected skill set sharing/export.
- `apps/app/src/app/pages/dashboard.tsx`
  - Remove protected skill share/export affordances there as well.
- `apps/desktop/src-tauri/src/commands/skills.rs`
  - Replace direct plaintext read/write behavior for protected skills with secure-cache behavior or remove access entirely for employees.
- `apps/share/*`
  - Protected skills should not be editable or publishable through the current share surface.

## What Can Be Reused With Minimal Change

- Session/task UX and task history concepts already exist.
- Desktop/local workspace selection already exists.
- Org/team scaffolding already exists in the enterprise controller.
- Reload-event infrastructure already exists and can help with "next use sees latest version".

## What Must Change Because It Conflicts With Your Requirement

- The current repo treats skills as readable markdown content.
- The current repo supports local skill read/write and skill sharing/export.
- The current hosted auth flow is password/social aware, not OTP-only.
- The current hosted worker provisioner is Render/Daytona-oriented, not AWS-oriented.

## Open Questions To Resolve Before Implementation

1. Is "employees can never extract protected skill prompts" a hard requirement, or is "best-effort local encryption + hidden UI" acceptable?
   If it is a hard requirement, protected skills should be remote-only.
2. Do you want the new backend API to live inside `ee/apps/den-controller`, or do you want a separate private service/repo?
3. What are the exact law-firm office IP/CIDR ranges?
4. Should Zeng's off-office exception be account-based, IP-based, or both?
5. Do non-protected/public skills still need sharing/export, or should all skill sharing be disabled?
6. Is the primary "local folder" experience the desktop app, or must the browser-only web app also open local folders directly?

## Suggested First Delivery Sequence

1. Replace auth with the Cognito passwordless email OTP flow.
2. Add skill metadata, versioning, and grant tables to the control plane.
3. Redact protected skill content everywhere in the current Cowork repo.
4. Build the admin skill create/update/publish UI for Zeng.
5. Decide whether protected skills are remote-only before building the final execution path.
