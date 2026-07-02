# OpenWork Bootstrap CLI

Script-installable `openwork-bootstrap` command for agent-first onboarding.

This package is intentionally small and does not assume npm is the install
channel. A bootstrap script can place `bin/openwork.mjs` on disk, then run:

```bash
openwork-bootstrap install --bin-dir ~/.local/bin --install-dir ~/.openwork/bootstrap
openwork-bootstrap doctor --json
openwork-bootstrap install app --manifest https://example.com/openwork-install-manifest.json
openwork-bootstrap doctor --app --json
OPENWORK_OWNER_PASSWORD='<generated-password>' openwork-bootstrap cloud onboard --base-url https://den.example.com --owner-email ada@example.com --org-name 'Ada Workspace' --invite-email teammate@example.com --skill-name 'First skill' --json
```

Current scope:

- `install` installs the lightweight CLI into a user-writable bin directory.
- `install app` downloads a manifest-selected desktop app artifact, verifies its
  SHA-256 digest, and installs it into a user-writable app directory.
  Supported artifact types: macOS `.dmg`, `.zip`, `.tar.gz`/`.tgz`, Linux
  `.AppImage`, and Windows `.exe`/`.msi` copy-installs.
- `doctor` verifies the CLI install and, optionally, a Den API health endpoint.
- `cloud onboard` drives the headless REST onboarding flow: sign up, sign in,
  create an org, invite a teammate, and create a starter skill.

This is a bootstrap layer; it does not replace the existing orchestrator CLI yet.
