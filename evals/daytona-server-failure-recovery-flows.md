# Daytona server failure recovery flows

End-to-end failure and recovery flows for a real Electron app connected to a
separate Daytona Den server sandbox.

## Preflight

1. Start a Daytona server sandbox with `.devcontainer/test-server-on-daytona.sh`.
2. Start a Daytona Electron sandbox against that server.
3. Sign into Cloud Account and create a local workspace.

## Flow 1: Den API outage and recovery

**Goal:** The desktop UI surfaces a recoverable error when Den API is down and
recovers when it returns.

### Steps

1. Open Settings -> Cloud -> Cloud Providers.
2. In the server sandbox, stop Den API:
   ```bash
   daytona exec SERVER_SANDBOX -- "bash -lc 'pkill -f ee/apps/den-api/src/server.ts || true'"
   ```
3. Click `Refresh` in Cloud Providers.
4. Restart the server stack:
   ```bash
   daytona exec SERVER_SANDBOX -- "bash -lc 'cd /workspace && bash .devcontainer/start-daytona-server.sh'"
   ```
5. Click `Refresh` again.

### Expected outcome

- During outage, Cloud Providers shows a clear network/server error.
- The app does not clear local cloud auth state.
- After restart, refresh succeeds and providers return.

## Flow 2: Den Web outage during sign-in

**Goal:** Browser sign-in failures do not leave partial desktop auth state.

### Steps

1. Start signed out in desktop.
2. Stop Den Web in the server sandbox.
3. Click `Sign in` from Cloud Account.
4. Restart Den Web.
5. Complete sign-in with a full handoff deep link.

### Expected outcome

- Initial browser sign-in fails visibly or opens an unreachable page.
- Desktop remains signed out.
- Sign-in succeeds after Den Web restarts.

## Flow 3: Worker proxy outage

**Goal:** Cloud worker UI handles worker proxy failure without affecting account
or provider sync.

### Steps

1. Open Settings -> Cloud -> Cloud Workers.
2. Stop worker proxy in the server sandbox.
3. Refresh Cloud Workers.
4. Open Cloud Providers and refresh.
5. Restart worker proxy.
6. Refresh Cloud Workers again.

### Expected outcome

- Cloud Workers shows a worker/proxy-specific error.
- Cloud Account and Cloud Providers continue to work.
- Worker state recovers after proxy restart.

## Flow 4: MySQL restart

**Goal:** Restarting MySQL causes temporary cloud errors and the stack recovers
without Electron restart.

### Steps

1. Stop MySQL in the server sandbox.
2. Refresh Cloud Account, Cloud Providers, and Settings -> Extensions marketplace.
3. Start MySQL again.
4. Restart Den API if needed.
5. Refresh the same desktop tabs.

### Expected outcome

- Each cloud tab shows a recoverable error during DB outage.
- No infinite loading state persists after recovery.
- Existing desktop auth token remains present.

## Flow 5: Server sandbox restart

**Goal:** A stopped and restarted server sandbox can serve the already-running
Electron client again.

### Steps

1. Sign in and import a provider.
2. Stop the server sandbox.
3. Verify cloud refresh fails in Electron.
4. Start the server sandbox again.
5. Restart `.devcontainer/start-daytona-server.sh` if needed.
6. Refresh Cloud Account and Cloud Providers.

### Expected outcome

- The desktop app does not need to be restarted.
- Cloud tabs recover after the server stack is healthy.
- Previously imported workspace config remains intact.
