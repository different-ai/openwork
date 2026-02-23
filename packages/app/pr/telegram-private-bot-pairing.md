## Summary

- Add Telegram `private` identity mode with pairing gate so first chat must send `/pair <code>` before any tool-running messages are accepted.
- Extend OpenWork server + app identity APIs to carry `access` and `pairingCode` fields.
- Update Messaging UI to create either public or private Telegram bots, surface one-time pairing code, and label identity rows as Public/Private.

## Evidence

- UI screenshot (Chrome MCP): `packages/app/pr/screenshots/telegram-private-pairing-code-mcp.png`

## Verification

- `pnpm --filter opencode-router typecheck`
- `pnpm --filter openwork-server typecheck`
- `pnpm --filter openwork-server test`
- `pnpm --filter @different-ai/openwork-ui typecheck`
- `pnpm --filter opencode-router build`
- `pnpm --filter @different-ai/openwork-ui build`

## Notes

- Telegram adapter startup with a dummy token fails expectedly with `401 Unauthorized`; pairing logic and code issuance still validate via OpenWork API and UI.
