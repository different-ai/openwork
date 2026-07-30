# Outbound network access for OpenWork

Status: maintainer pointer

The canonical machine-readable allowlist source is [`outbound-access.json`](./outbound-access.json). Keep new hosts, blocked effects, override names, and component ownership there first; CI validates it with `node scripts/check-outbound-access.mjs`.

The published customer-facing guidance lives in [`packages/docs/start-here/outbound-network-access.mdx`](../../packages/docs/start-here/outbound-network-access.mdx) and is surfaced in the Self-host docs navigation as **Outbound network access**.

Do not maintain a second full human allowlist in this repository file. If customer wording needs to change, update the published page and keep this file as the stable internal path for maintainers and automation.
