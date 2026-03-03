# OpenWork User Tutorial (End-to-End)

This tutorial walks a new user from install to a successful first task.

## Goal

At the end of this guide, you will:

- run OpenWork locally,
- connect a model/provider,
- complete one real task with permissions,
- verify outputs,
- optionally connect to a remote worker.

## Audience

- Bob (IT / power user) who wants a complete operational walkthrough.
- Contributors who need a reliable onboarding flow to test against.

## Prerequisites

1. Install OpenWork desktop from Releases: `https://github.com/different-ai/openwork/releases`
2. Ensure OpenCode CLI is available on PATH:

```bash
opencode --version
```

3. Have at least one model/provider credential configured for your OpenCode setup.

## Step 1: Launch OpenWork

1. Open the app.
2. Create or select a workspace folder.
3. Wait for status to show the local runtime is healthy.

Expected behavior:

- App opens without crash.
- Workspace appears in sidebar.
- Status shows healthy/connected state.

## Step 2: Configure model and thinking level

1. Open session composer controls.
2. Pick a model from the model picker.
3. Set thinking level (none/low/medium/high/xhigh).

Expected behavior:

- Selected model and thinking level persist in session UI.
- Composer remains enabled and ready to send.

## Step 3: Run your first real task

Use a concrete prompt, for example:

"Create a 5-item action plan to migrate a small Node service to TypeScript, with risks and rollback notes."

Expected behavior:

- Prompt streams response into the session.
- Steps/todo timeline updates as the run progresses.
- Session remains interactive while events stream.

## Step 4: Handle permissions safely

When prompted for permission:

1. Review the requested action.
2. Choose one of: allow once, allow always, or deny.

Expected behavior:

- Permission card explains what is being requested.
- Your choice is reflected immediately in run progression.

## Step 5: Validate output artifacts

1. Open generated files or suggested commands from the session.
2. Confirm outputs are written to expected workspace paths.
3. Re-run the task with a small change request.

Expected behavior:

- Artifacts open correctly from the session UI.
- Follow-up prompts continue in the same session context.

## Step 6 (Optional): Connect remote worker

1. Use `Add worker` in the app.
2. Choose `Connect remote`.
3. Provide remote URL/token.
4. Send a test prompt to that worker.

Expected behavior:

- Worker appears as connected.
- Prompt/response round-trip succeeds through remote path.

## Troubleshooting quick checks

- `Failed to load tasks`: refresh worker and verify workspace path + runtime health.
- No model responses: confirm provider credentials and selected model availability.
- Missing `opencode`: install/update CLI and restart OpenWork.
- Permission deadlocks: review pending permission cards and resolve them explicitly.

## Acceptance checklist

- [ ] OpenWork launched and workspace loaded.
- [ ] Model selected and prompt sent successfully.
- [ ] At least one permission flow handled.
- [ ] Session output validated in local files.
- [ ] Optional remote worker connection validated.

## Next guides

- For orchestrator-only workflows, see `packages/orchestrator/README.md`.
- For messaging connectors, see `packages/opencode-router/README.md`.
