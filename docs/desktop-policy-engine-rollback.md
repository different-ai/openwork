# Desktop managed-policy engine rollback

OpenWork no longer automatically registers the `managed-policy-next` plugin in
OpenCode. Agent tools no longer wait for its per-tool IPC policy checks. The
engine is started without the policy IPC channel.

Restart OpenWork and its managed engine after upgrading. Rewriting generated
configuration does not unload hooks already installed in a running engine.

## Configuration cleanup

The generated engine configuration is replaced before startup without its old
`managed-policy` directory registration. Old plugin files are retained because
another configuration may reference them.
Ordinary user plugins remain supported. Explicit registrations in user-owned
configuration are not deleted automatically.

## Enforcement that remains

- Server request admission, configuration-management gates, terminal and saved
  command gates, and model checks at the server request boundary.
- Independent generated engine command permissions; built-in web
  fetching/search restrictions when approved sites are configured.
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
