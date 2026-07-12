# remote-workspace-resilience — remote workspaces remain visible while OpenWork reconnects

1. A user starts with local and remote workspaces visible in the sidebar, including tasks loaded from a remote OpenWork server discovered through OpenWork Cloud.

2. When the client temporarily loses its connection to Den or an OpenWork server, the remote workspace stays in place with its cached tasks and a clear Remote · Reconnecting status instead of disappearing.

3. OpenWork treats a failed refresh as unknown state, never as deletion: desktop connection details remain authoritative for routing, the last successful server snapshot remains visible, and only an explicit removal or a successful live response can remove a workspace.

4. When connectivity returns, OpenWork retries automatically, reconciles the live workspace list without duplicates or reordering, clears the warning, and restores normal task actions without requiring the user to add the remote workspace again.
