# Phone protocol 1

The closed JSON schemas in `src/schema/contract.json` and `send.json` are the source of truth. `fixtures/normalized/` contains synthetic examples. Responses use `{ data, cursor }`; errors contain stable codes and a request ID, never upstream error bodies or credentials.

| Operation | Endpoint |
| --- | --- |
| Claim a short-lived code, poll approval, acknowledge Keychain storage | `POST /v1/pairings/claim`, `/v1/pairings/poll`, `/v1/pairings/ack` |
| Host compatibility and current phone scope | `GET /v1/host`, `/v1/device/access` |
| Allowed projects and chats | `GET /v1/workspaces`, `/v1/workspaces/:wid/sessions` |
| Create a chat | `POST /v1/workspaces/:wid/sessions` |
| Read chat, messages, status and approvals | `GET /v1/workspaces/:wid/sessions/:sid` with `/messages`, `/status`, `/approvals` |
| Send or interrupt | `POST /v1/workspaces/:wid/sessions/:sid/messages`, `/stop` |
| Reply to a supported approval | `POST /v1/workspaces/:wid/sessions/:sid/approvals/:aid/reply` |
| Read/change the current chat model and reasoning | `GET` / `POST /v1/workspaces/:wid/sessions/:sid/model-settings` |
| Read/revoke saved permission | `GET /v1/workspaces/:wid/sessions/:sid/permissions`, `POST .../permissions/:pid/revoke` |
| Disconnect this phone | `DELETE /v1/device` |
| Scoped event stream | `GET /v1/events` |

Except for pairing claim/poll, callers need their own bearer credential. No query-string credentials are accepted. Pairing approval, scope edits, credential revocation and creation of pairing windows are local desktop controls, never phone routes. Pairings/ack authenticates its pending credential separately before activating it.

The host advertises its real upstream version and capabilities. An embedded adapter accepts only the version supplied by its own desktop build; the independent standalone adapter remains pinned to the separately qualified 0.18.57 profile. Unknown profiles stay incompatible. Compatibility and write capability are separate, so a supported read-only profile remains supported.

Use a fresh UUID `requestId` per intentional mutation and keep it until a receipt is reconciled. The host binds it to device, route and canonical body. Repeating the same endpoint, request ID and body returns the stored receipt without forwarding the mutation again; there is no separate receipt lookup endpoint. Receipts distinguish `pending`, `accepted`, `confirmed`, `rejected` and `outcome_unknown`. A model/permission/approval change also requires a current revision. Never blindly resend an ambiguous operation with a new ID.

SSE contains normalized events, supports bounded replay, and requests a snapshot refresh when replay is no longer available. Workspaces outside the phone's current grant never enter the stream. Access changes terminate active streams so reconnect uses the new grant.

Prompts are limited to 32 KiB, request bodies to 40 KiB, and normalized snapshots to 8 MiB. Unknown content blocks render as a computer-only placeholder rather than raw HTML or upstream JSON. This protocol is intentionally smaller than OpenWork's local server API.

### Rename an existing chat

Hosts may advertise optional `capabilities.renameSession`. Clients connected to older hosts must keep Rename unavailable.

`POST /v1/workspaces/:wid/sessions/:sid/rename` accepts only `requestId` (UUID), `title` (trimmed, 1–200 Unicode scalar values), and `previousTitle` (the last observed title). It uses the same device/project/session authorization and durable mutation ledger as other writes. A changed title detected before forwarding returns 409; this is a best-effort stale-edit check, not an upstream atomic compare-and-swap. A duplicate request ID returns its retained receipt. The adapter sends only the title to the existing OpenCode v2 rename action and never retries a failed write. Clients read the session back to confirm the title, including after an uncertain response.

Renaming remains inside the default-off `remoteAccess` feature on cloud and self-hosted deployments. Turning Remote access off removes the entire phone surface and preserves chat names and existing data.
