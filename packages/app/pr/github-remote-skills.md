title: GitHub remote skills (server-first)
description: Browse skills from GitHub repos without installing; install on demand via OpenWork server or host
---

## Set context
OpenWork users want to discover skills stored in GitHub repos without installing them first. Today, skills only appear after they exist on disk under `.opencode/skills` or `.claude/skills`, which forces a full install before discovery. This PRD defines a server-first remote skills flow that lists skills from GitHub repositories and allows per-skill installation. When an OpenWork server is available, it should handle indexing and metadata to keep remote clients lightweight and aligned with OpenCode parity.

The feature must match OpenCode's supported skill patterns:
- `.opencode/skills/<skill-name>/SKILL.md`
- `.opencode/skill/<skill-name>/SKILL.md` (legacy)
- `.claude/skills/<skill-name>/SKILL.md`

Each skill name is the directory name and must be kebab-case (same validation as `packages/desktop/src-tauri/src/commands/skills.rs`). The description is derived from the first non-empty, non-frontmatter, non-header line in `SKILL.md`.

## Define goals
- List skills from GitHub repos without writing to the filesystem.
- Install a selected remote skill into the current workspace only when the user clicks Install.
- Prefer OpenWork server for listing, caching, and metadata resolution; fallback to GitHub direct only when server is unavailable.
- Preserve OpenCode parity by honoring skill path conventions and name validation rules.
- Provide a premium, mobile-first UI in the Skills page with clear status and safety messaging.

## Mark non-goals
- OpenPackage or registry integration.
- Private repo OAuth or token management (future).
- Installing arbitrary repo files beyond `SKILL.md` (future; only the skill doc is installed in this phase).
- Multi-repo search or global indexing beyond the explicitly added sources.

## Describe personas
- Power user: wants fast GitHub installs and minimal ceremony.
- New user: needs clear trust cues and an easy way to browse without affecting the workspace.
- Remote client user: relies on OpenWork server for filesystem operations.

## Define key terms
- Remote skill source: a GitHub repo reference provided by the user.
- Remote skill: a skill derived from a `SKILL.md` found in supported paths in the repo.
- Installed skill: a skill present in `.opencode/skills` or `.claude/skills` in the workspace search roots.

## User flows
### Host mode (desktop)
1) User opens Skills tab.
2) Adds GitHub repo source.
3) OpenWork server indexes remote skills and returns list.
4) User clicks Install on a specific skill.
5) Skill is written to `.opencode/skills/<name>/SKILL.md`.
6) Installed list refreshes and the remote skill shows Installed.

### Client mode (OpenWork server)
1) User opens Skills tab in client mode.
2) Adds GitHub repo source.
3) Client calls OpenWork server to fetch remote skills.
4) User clicks Install on a skill.
5) OpenWork server writes the skill to the host workspace.
6) Client refreshes installed list via server and shows Installed.

### Client mode (no OpenWork server)
1) Skills page shows a short access hint: remote install requires OpenWork server.
2) Remote listing can be disabled or read-only depending on capability.

## UX requirements
- Add a new Remote skills section in `packages/app/src/app/pages/skills.tsx`.
- Input supports:
  - `github:owner/repo`
  - `github:owner/repo#branch`
  - `https://github.com/owner/repo`
  - `https://github.com/owner/repo/tree/branch/path`
- Each remote skill card shows: name, description, repo, path, and Install/Installed button.
- Show source grouping (repo + ref) with a remove option for the source.
- Provide inline status text for fetch errors and install errors.
- Ensure the UI remains responsive during listing or install.

## Functional requirements
- Validate skill name as kebab-case. Skip invalid entries with a status note per source.
- Deduplicate skills by name within a source; if duplicates exist across sources, show a conflict badge and require user choice to install.
- Only install into `.opencode/skills` in the active workspace.
- Respect OpenWork server capabilities:
  - If `capabilities.skills.read` and `capabilities.skills.write` are available, use OpenWork server paths.
  - If only read is available, show list but disable Install.

## Data model
### RemoteSkillSource
- id: string (stable hash of normalized source)
- input: string (raw user input)
- repo: string (owner/repo)
- ref: string | null (branch/tag/sha)
- pathPrefix: string | null (if source contains a subpath)
- resolvedRef: string | null (commit sha from server)
- lastFetchedAt: number
- fetchStatus: "idle" | "loading" | "error" | "success"
- errorMessage: string | null

### RemoteSkill
- name: string
- description: string | null
- sourceId: string
- repoPath: string (relative path to skill dir)
- skillFilePath: string (relative path to SKILL.md)
- contentUrl: string (raw URL to SKILL.md, server-provided or GitHub raw)
- ref: string | null
- installStatus: "idle" | "installing" | "installed" | "error"
- installError: string | null

### Storage
- Persist sources in OpenWork config (server-first):
  - `openwork.remoteSkills.sources[]` in OpenWork server workspace config.
- Client-only fallback (no server): store sources in local storage keyed by workspace id.

## API design (OpenWork server)
Introduce server endpoints that proxy GitHub, cache results, and write to disk.

### `GET /workspace/:id/skills/remote?sources=...`
- Input: array of source strings or source ids.
- Output: list of RemoteSkill entries grouped by source.
- Server resolves default branch, path prefix, and computes raw content URLs.
- Server caches by source + ref with ETag/If-None-Match and TTL.

### `POST /workspace/:id/skills/remote/install`
- Body: { sourceId, name, contentUrl }
- Server fetches SKILL.md content, validates name, writes to `.opencode/skills/<name>/SKILL.md`.

### `PATCH /workspace/:id/config`
- Persist `openwork.remoteSkills.sources` in workspace config.

## GitHub fallback behavior
If OpenWork server is unavailable:
- Use GitHub REST API to list repo tree and locate `SKILL.md` paths under supported roots.
- Use raw content URL to fetch `SKILL.md` for description and for install payload.
- Respect rate limits and provide a retry hint on 403/429.

## State management changes
File: `packages/app/src/app/context/extensions.ts`
- Add signals: `remoteSkillSources`, `remoteSkills`, `remoteSkillsStatus`.
- Add actions: `addRemoteSkillSource`, `removeRemoteSkillSource`, `refreshRemoteSkills`, `installRemoteSkill`.
- Wire OpenWork server client usage when `workspaceType === "remote"` and capabilities allow.

## UI wiring
Files:
- `packages/app/src/app/pages/skills.tsx` (render remote section)
- `packages/app/src/app/pages/dashboard.tsx` (pass props)
- `packages/app/src/app/app.tsx` (bind store state)
- `packages/app/src/i18n/locales/en.ts` and `packages/app/src/i18n/locales/zh.ts` (strings)

## Desktop/Tauri changes
Files:
- `packages/app/src/app/lib/tauri.ts` (new command wrapper for installing remote skill content)
- `packages/desktop/src-tauri/src/commands/skills.rs` (new command to install remote skill content)
- `packages/desktop/src-tauri/src/lib.rs` (register command)

## Error states
- Invalid repo: "Repository not found."
- No skills found: "No skills found in supported paths."
- Rate limit: "GitHub rate limit exceeded. Try again later."
- Install conflict: "Skill already exists in workspace."
- Name invalid: "Skill name must be kebab-case."
- Server unavailable: "OpenWork server unavailable. Remote install requires host mode."

## Permissions and safety
- Listing: network access only, no filesystem writes.
- Install: requires filesystem write access to `.opencode/skills` only.
- Block installs when OpenWork server write capability is false.
- Sanitize path input and prevent path traversal on install.

## Performance requirements
- Listing should resolve within 2s for common repos (with server cache).
- UI remains interactive while requests are in flight.
- Cache remote results for 5 minutes by default on server side.

## Telemetry
- `remote_skills_source_added`
- `remote_skills_list_success`
- `remote_skills_list_error`
- `remote_skills_install_success`
- `remote_skills_install_error`
Include metadata: source type, host/client mode, latency bucket, error code.

## Rollout plan
- Ship behind a feature flag (OpenWork config or build-time flag).
- Enable for internal builds first.
- Expand to all desktop users after telemetry indicates >98% success.

## QA checklist
- Add source with valid GitHub repo.
- Add source with invalid repo.
- Repo with no supported skill paths.
- Repo with multiple skills and nested paths.
- Duplicate skill name across sources.
- Install success path and uninstall from installed list.
- Client mode with server available (read/write).
- Client mode with server unavailable (read-only).

## Open questions
- Should remote sources be shared across clients by default, or per-user?
- Should we support installing the entire skill folder (additional assets) in a later phase?
- How should we surface trust signals (verified orgs, license) without full registry support?

## Acceptance criteria
- Remote skills list appears without installing any files.
- Supported skill paths match OpenCode conventions.
- Per-skill install writes to `.opencode/skills/<name>/SKILL.md`.
- OpenWork server is used when available; GitHub direct is fallback only.
