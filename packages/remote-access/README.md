# Desktop Remote access

Connect a phone to the OpenWork desktop already running on your computer. Settings → Remote access owns pairing, project access and the bridge lifecycle. Quitting OpenWork stops the bridge; reopening it restores explicitly enabled access with the same device credentials.

This contribution targets macOS and Linux desktop with OpenCode v2 enabled for chats. It is off by default (`remoteAccess`). Packaged applications use the effective Den deployment/organization policy, fetched in the main process from the trusted deployment. A development build can opt in with `DEN_FEATURE_REMOTE_ACCESS=true`; this override is ignored by packaged applications.

The independently maintained [OpenWork Remote iOS client](https://github.com/BitL8-ByteShort/openwork-remote-ios) uses this protocol. Its source, release process and platform support remain in its own repository. This contribution does not require OpenWork's maintainers to own an iOS application.

## Setup

1. Run Tailscale on the computer and phone, with permission to connect within the same private network. Enable MagicDNS and HTTPS in the tailnet.
2. Enable OpenCode v2 for chats in OpenWork's Advanced settings. Remote access reads this setting; it never switches engines or migrates chats.
3. Open Settings → Remote access and turn it on. Choose **Pair a phone**.
4. Scan the five-minute QR code or paste it into the client. Review the phone's request on the computer and select projects. **Allow all current and future projects** is a separate, unchecked option.
5. Use **Manage** to change access or **Disconnect** to revoke a phone. Keep the computer awake with OpenWork and Tailscale running.

No separate Node installation, shell command or browser admin page is required by the packaged desktop. The bridge is bundled into Electron. Existing Tailscale Serve routes are reused; otherwise it adds an unused HTTPS port from 9443–9453 without replacing another service. Setup reports a recovery action if Tailscale needs operator configuration.

## Boundaries

- The phone reaches only the authenticated, scoped `/v1` API. It never receives OpenWork's upstream credential, arbitrary proxy access, a shell endpoint or raw filesystem access.
- Pairing requires explicit desktop approval. Credentials are random, stored as hashes by the host, and become active only after the client acknowledges secure storage. QR codes expire; persistent device access lasts until revoked.
- Project scope is checked on reads, mutations and events. Revocation and access edits close existing streams. Granting a project lets the phone run its existing agent with that project's current tools and credentials, subject to OpenWork's approval rules.
- A capable client can rename existing chats. The bridge checks project scope and the last observed title, keeps durable request receipts, and never automatically repeats a lost write. Older clients remain compatible.
- Only supported `external_directory` approval requests can be allowed once or denied. General approval-mode changes and automatic approvals are unsupported. Models and reasoning variants are validated against the host catalog; changes affect the selected chat.
- Mutations use durable request IDs. An uncertain result is reported as `outcome_unknown`; sending is never automatically repeated. Reusing a retained request ID returns its receipt without forwarding again; receipts are retained for at least 30 days.
- The listener binds to `127.0.0.1:9288`. Tailscale Serve supplies private HTTPS with normal certificate validation. Public Funnel routes targeting the bridge are rejected. The embedded mode opens no admin HTTP listener.
- Administration uses a fixed IPC allowlist from the live desktop main frame. A renderer-supplied URL, token or feature boolean cannot redirect the bridge to another upstream.

See [protocol](docs/protocol.md) and [qualification](docs/qualification.md). This is a desktop preview, not a claim of Windows, headless, every Linux distribution or App Store support.

## State and handover

macOS uses `~/Library/Application Support/OpenWorkRemote`; Linux uses `$XDG_STATE_HOME/openwork-remote`, falling back to `~/.local/state/openwork-remote`. Directories must be owned by the current user and mode `0700`; files are `0600`. Symlinks and unsafe modes are rejected. A process lock prevents the standalone and embedded bridges from sharing a writable store.

Stop an existing standalone bridge before enabling this feature. The desktop reuses host identity, device hashes, selected/future-project grants and the mutation ledger. It does not change saved OpenWork chats, provider credentials, workspace defaults or saved agent permissions. Ordinary development profiles have isolated bridge storage. `OPENWORK_DEV_SHARED_STATE=1` opts a development build into the existing desktop/bridge state and requires the installed app and standalone bridge to be stopped first.

Turning Remote access off stops its listener and streams while retaining pairing data. The existing Tailscale Serve configuration remains for reuse; a stopped loopback listener cannot serve phone requests. Disabling deployment policy also stops access. Policy decisions are cached for 15 seconds and refreshed by the desktop every 15 seconds; a failed refresh denies access.

## Development

From the workspace root, use the pinned pnpm version and Node 24:

```sh
pnpm install --frozen-lockfile
pnpm --filter @openwork/remote-access build
pnpm --filter @openwork/remote-access test
node --test apps/desktop/tests/remote-access*.test.mjs
pnpm --dir apps/app exec bun test tests/remote-access.test.tsx
pnpm --filter @openwork/desktop check:electron
pnpm --filter @openwork/desktop typecheck:electron
```

The build bundles runtime dependencies and writes `LICENSE` and `THIRD_PARTY_NOTICES.txt` next to `index.cjs`. Notices come from the actual esbuild dependency graph. `abstract-logging@2.0.1` links its MIT license instead of shipping a file; its attributed copy is under `licenses/`. OpenWork's existing root license remains unchanged. This package's original code is MIT licensed.
