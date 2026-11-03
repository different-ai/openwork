# CI changes

- Keep cheap static checks independent of unrelated builds, services and tool
  setup. Sharing a workflow is fine; adding a `needs` edge or appending a check
  to another job requires a real data dependency, not convenience.
- Install only the workspace dependencies a job uses. Scope path filters to
  its inputs, including its scripts, workflow and dependency configuration.
- When separating checks, keep the assertions and failure behavior intact;
  review required-check configuration rather than silently dropping coverage.
- For a repaired CI dependency mistake, add a small regression test of that
  boundary. Do not introduce a new CI orchestration framework for it.
