# Phase 7 Learnings

Read this file before starting Phase 7. Prepend any new Phase 7 learnings under `## Entries`.

## Entries

### 2026-04-14 - Config writes landed with explicit reload and audit follow-through
- Workspace config patch and raw OpenCode write routes now rematerialize managed files, emit explicit config reload events, and record workspace audit entries directly.
- The practical takeaway is to keep projection centralized, then make the mutation route own the reload and audit signal instead of waiting on watcher follow-up.

### 2026-04-14 - Local-only ownership stayed practical for this phase
- The implemented Phase 7 file and config services deliberately support local, control, and help workspaces only.
- Remote config and file mutation still stay on the legacy direct path, so Phase 7 completion should be read as local-workspace migration rather than full remote parity.
