# Cloud worker flows

End-to-end user flows for launching and connecting remote OpenWork workers from
the desktop app.

## Preflight

1. Start the Daytona Den server sandbox with worker proxy enabled.
2. If testing real Daytona worker provisioning, configure `DEN_PROVISIONER_MODE=daytona` and Daytona credentials on the server sandbox.
3. Start an Electron sandbox against the Den server.
4. Sign into Cloud Account and select an org.

## Flow 1: Launch remote worker

**Goal:** A user launches a cloud worker from desktop and sees it appear in Cloud
Workers.

### Steps

1. Open Settings -> Cloud -> Cloud Workers.
2. Click the create/launch worker action.
3. Enter a worker name.
4. Submit the form.
5. Poll the Cloud Workers page until the worker appears.

### Expected outcome

- The worker row appears with a provisioning or ready status.
- Den API records a worker for the active org.
- If `DEN_PROVISIONER_MODE=stub`, the UI clearly shows stub URL behavior.
- If `DEN_PROVISIONER_MODE=daytona`, the worker gets a real Daytona preview URL.

## Flow 2: Connect remote workspace

**Goal:** A launched cloud worker can be connected as a remote workspace in the
desktop app.

### Steps

1. Complete Flow 1 and wait for a ready worker.
2. Click the connect/open action on the worker row.
3. Follow the desktop remote workspace flow.
4. Verify the sidebar shows the remote workspace.

### Expected outcome

- A remote workspace is added to the desktop workspace list.
- The workspace status reaches ready.
- The app does not require local folder authorization for the remote workspace.

## Flow 3: Run a task on remote worker

**Goal:** A user can run a simple task against the remote worker after connecting
it.

### Steps

1. Open the connected remote workspace.
2. Create a new task.
3. Send a simple prompt such as `List the workspace root files.`
4. Wait for the assistant response.

### Expected outcome

- The task starts and streams normally.
- Tool calls and file results come from the remote worker workspace.
- No local workspace path is leaked into the remote task.

## Flow 4: Worker token refresh

**Goal:** A connected worker continues working after the desktop refreshes worker
metadata or tokens.

### Steps

1. Connect a remote workspace.
2. Restart the Electron app or reload the workspace.
3. Open Cloud Workers and refresh.
4. Return to the remote workspace and run a task.

### Expected outcome

- Worker metadata reloads successfully.
- The remote workspace remains connected or reconnects cleanly.
- Task execution still works.

## Flow 5: Worker failure recovery

**Goal:** The UI handles a worker that is stopped or unreachable.

### Steps

1. Connect a worker.
2. Stop or delete the underlying worker sandbox.
3. Return to the remote workspace.
4. Open Cloud Workers and refresh.

### Expected outcome

- The UI shows a clear unreachable/stopped state.
- The app does not spin forever in ready state.
- Recovery controls, if present, are actionable.
