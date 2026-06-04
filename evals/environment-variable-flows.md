# Environment variable flows

End-to-end scenarios for a user managing local environment variables from the
desktop Settings UI. These flows target the redesigned environment settings
surface and should run against a real Electron app through CDP.

## Preflight

1. Start Electron from a clean profile or a dedicated Daytona sandbox:
   ```bash
   bash .devcontainer/test-on-daytona.sh <branch-or-commit>
   ```
2. Create or select a local workspace.
3. If possible, point the environment store at an eval-only file before launch,
   for example `/tmp/openwork-env-eval.json`, so file verification cannot touch
   a user's real secrets.
4. Open Settings -> Environment through the UI or by navigating the renderer to
   the environment settings route.

## Flow 1: Add, reveal, edit, and delete a variable

**Goal:** A user can manage a local secret without exposing it by default.

### Steps

1. Click `Add variable`.
2. Enter `EVAL_UI_SECRET` as the name and `alpha-secret` as the value.
3. Save the variable.
4. Confirm the table shows `EVAL_UI_SECRET` with the value masked.
5. Click the row reveal action, then hide it again.
6. Edit the value to `beta-secret` and save.
7. Delete the variable and confirm the destructive action.

### CDP steering

- Use `browser_eval` to click buttons by visible text.
- Use normal form controls for the name input and value textarea.
- For row assertions, read `document.body.innerText` and query buttons within
  the row containing `EVAL_UI_SECRET`.

### Verification

- File/API state contains `EVAL_UI_SECRET=alpha-secret` after add.
- File/API state contains `EVAL_UI_SECRET=beta-secret` after edit.
- File/API state no longer contains `EVAL_UI_SECRET` after delete.

### Pass criteria

- Values are masked before reveal.
- Reveal exposes only the selected row value.
- Add/edit/delete update the table without a full reload.
- A pending-changes banner or equivalent status appears after save.
- No secret value is visible after hiding or deleting it.

## Flow 2: Validation protects existing secrets

**Goal:** Bad names, reserved names, and duplicate keys are rejected without
overwriting existing values.

### Steps

1. Preseed `DUPLICATE_KEY=original` through the env API or eval store file.
2. Try to add `1BAD=value`.
3. Try to add `OPENWORK_TOKEN=value`.
4. Try to add `DUPLICATE_KEY=overwritten`.

### CDP steering

- Open the add-variable modal for each attempt.
- Fill the name/value fields and click `Save`.
- Read inline validation text while the modal remains open.

### Verification

- `DUPLICATE_KEY` remains `original` in the env API/file store.
- No invalid or reserved key is persisted.

### Pass criteria

- Invalid names show a user-readable validation message.
- Reserved `OPENWORK_`/`OPENCODE_` names are blocked.
- Duplicate names do not overwrite existing values.

## Flow 3: Apply changes activates the runtime environment

**Goal:** A saved variable becomes active after the user applies environment
changes.

### Steps

1. Add `EVAL_APPLY_KEY=apply-secret`.
2. Confirm the pending-changes banner is visible.
3. Click `Apply changes` and confirm the warning modal.
4. Return to the workspace and create a new task.
5. Ask the agent to print `process.env.EVAL_APPLY_KEY` with a simple shell or
   Node command.

### CDP steering

- Click `Apply changes`, confirm the modal, then use the sidebar `New task`
  action.
- Type into the Lexical composer with `document.execCommand('insertText', ...)`.
- Submit with the normal `Run task` button.

### Verification

- Pending state is cleared from local storage or the settings API after apply.
- The env API/file store still contains `EVAL_APPLY_KEY=apply-secret`.
- The task output includes `apply-secret`.

### Pass criteria

- Apply requires explicit confirmation.
- The settings page reports that changes are active.
- A new task sees the updated environment.

## Flow 4: Remote workspaces do not expose local secrets

**Goal:** Local environment variables are hidden while a user is viewing a
remote workspace.

### Steps

1. Preseed `REMOTE_SHOULD_NOT_LEAK=secret` in the local env store.
2. Select a remote workspace.
3. Open Settings -> Environment.

### CDP steering

- Navigate through the visible Settings UI while the remote workspace is active.
- Inspect `document.body.innerText` and available action buttons.

### Verification

- The local env API/file store is unchanged.
- If network inspection is available, no local env list request is made for the
  remote-only view.

### Pass criteria

- The page shows a clear remote-workspace explanation.
- `Add variable` and row actions are absent.
- `REMOTE_SHOULD_NOT_LEAK` and `secret` never appear in the DOM.
