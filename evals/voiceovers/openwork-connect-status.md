# micx-connect-status — Show non-blocking Connect lifecycle health

1. When signed in, the status bar shows Micx Connect: Checking during startup, authentication restoration, or an OpenCode restart.

2. One shared lifecycle flow reconciles and checks Micx Connect in the background. Messages remain unblocked.

3. Success changes the status to Micx Connect: Ready.

4. After bounded retries fail, it turns red: Micx Connect: Needs attention. Opening it offers Run diagnostics.

5. When signed out, the Micx Connect status is not shown.
