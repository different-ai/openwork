# Desktop managed-policy engine rollback

OpenWork no longer automatically registers `managed-policy` in OpenCode v1 or
`managed-policy-next` in OpenCode v2. Agent tools no longer wait for these
plugins' per-tool HTTP or IPC policy checks. The v2 engine is started without
the policy IPC channel; v1 no longer receives a policy-evaluation credential.

Restart OpenWork and its managed engines after upgrading. Rewriting generated
configuration does not unload hooks already installed in a running engine.

## Configuration cleanup

The v1 generated runtime configuration omits the managed plugin, including
copies of either current managed plugin path persisted in the runtime plugin
list (plain paths or file URLs). The v2 generated configuration is replaced
before startup without its old `managed-policy` directory registration.
Old plugin files are retained because another configuration may reference them.
Ordinary user plugins remain supported. Explicit registrations in user-owned
configuration are not deleted automatically.

## Enforcement that remains

- Server request admission, configuration-management gates, terminal and saved
  command gates, and model checks at the server request boundary.
- Independent generated engine command permissions in both generations;
  built-in web fetching/search restrictions when approved sites are configured.
- Native built-in browser request, origin, and upload gates.
- Local engine approvals, Den authorization and model assignment, and desktop
  capability and branding controls.

Command and browser controls remain visible because their enforcement does not
depend solely on the removed plugin.

## Enforcement removed

- Engine-local protected-configuration checks before file writes, edits, and
  patches. Server configuration endpoints still have their own gates, but an
  engine file tool no longer calls the policy service to protect these paths.
- Policy synchronization before read-only and otherwise unclassified tools.
  An already-running turn no longer revalidates policy at every tool boundary.
- Hook-time model checks in engine session/chat hooks. Server admission and Den
  inference authorization remain separate checks; they do not recreate those
  in-engine hooks.
- Live per-tool command/browser/extension classification by the managed plugin.
  Generated permissions and native/server gates continue independently, without
  making a fresh policy request from every engine tool.

These remaining controls are not a replacement for the removed engine-local
checks or an OS sandbox. This rollback does not deploy an upgrade or restart any
existing desktop automatically.
