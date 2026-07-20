# windows-workspace-session-performance - Windows workspace/session performance

1. I first confirm this is the packaged Windows Electron app, not a dev shell, and capture the baseline runtime metrics before the benchmark touches any data.

2. The eval creates benchmark-prefixed workspaces and real OpenCode sessions through OpenWork's own APIs, then proves the loaded app can still switch between those sessions quickly.

3. Finally, the eval starts concurrent real model conversations in isolated sessions, waits for each assigned marker, and shows one completed marker in the app with no cross-session leakage.
