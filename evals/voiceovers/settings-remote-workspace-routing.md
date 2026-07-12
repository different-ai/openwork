# settings-remote-workspace-routing — remote tasks use the same owning endpoint on every route

1. A remote OpenWork workspace shows its task history in the main Session sidebar while the user’s local OpenWork server also has its own local workspaces.

2. The user opens Settings for that remote workspace, and the same remote tasks remain visible instead of becoming an empty list merely because Settings changed routes.

3. Settings resolves every workspace through the shared workspace-endpoint contract: local workspaces use the local server, while remote workspaces use their saved worker URL, token, and server-side workspace ID.

4. A remote worker failure produces the existing worker-specific diagnostic and recovery actions, while returning to Session preserves the same workspace, task selection, and endpoint identity.
