# Secret handles for the built-in browser

A person saves a password, one-time code, or API key or token for one
conversation, and lists the sites it may go to. When the agent signs in on one
of those sites in the built-in browser, it refers to the secret by a handle:
it never receives the value, and neither does the page's script.

- Feature key: `browserSecretHandles`
- Deployments: cloud and self-hosted, off by default
- Author: `benjaminshafii`
- Surface: OpenWork desktop (the built-in browser). The cloud browser host
  uses the same store and the same swap rules.

## How it works

1. The person enters the secret in OpenWork's own dialog (Secrets, in the
   browser toolbar): a name, a type, the allowed sites as exact `https://`
   origins, and the value. The value goes straight to the desktop's main
   process and is kept in memory only, per conversation. It is not written to
   disk, logs, or the conversation.
2. The agent sees each secret's handle, name and type for pages on an allowed
   site, and asks to fill one with the `fill_secret` browser action. It never
   passes or receives the value.
3. OpenWork asks the person in the chat each time: `Fill “name” on site?`,
   with the type and the kind of field. A standing "always for this site"
   approval for typed passwords never covers a saved secret.
4. On Fill, a random placeholder is typed into the field. The page and its
   scripts hold only the placeholder.
5. When the page sends its request, OpenWork replaces the placeholder with the
   value in the outgoing request, only when that request goes to one of the
   secret's allowed sites. A request to any other destination keeps the
   placeholder.
6. Everything the browser tools return to the agent is checked for the value
   and the placeholder, in the encodings a page could echo them in, and both
   are replaced before the agent reads them. A page that received a secret is
   not screenshotted.

The existing way of signing in, where the agent types a value the person gave
it in chat, is unchanged and keeps its own approval card.

## How to try it

1. Turn on `browserSecretHandles` for your organization in `/admin` ›
   organization › Features.
2. In OpenWork desktop, open a conversation and its built-in browser, and go
   to the sign-in page of a site.
3. Choose Secrets (the key in the browser toolbar). Add a name, pick the type,
   keep or edit the allowed site, enter the value, and choose Save secret.
4. Ask the agent to sign in with the saved secret.
5. Approve the `Fill “name” on site?` card in the chat. The field fills and
   the sign-in goes through; the agent's steps show the handle and an outcome,
   never the value.
6. Remove the secret from the same dialog when you are done. Quitting
   OpenWork also forgets every secret.

## Turning it off

Turning the feature off, for the organization or with the kill switch, takes
effect without a restart:

- Every saved secret is cleared from memory.
- Placeholders already typed into pages are revoked, so a request that still
  carries one is sent with the placeholder only.
- The `fill_secret` action answers `secrets_unavailable`, and the agent hands
  the sign-in back to the person.
- The Secrets control leaves the browser toolbar.
- Typing a credential the person gave the agent in chat works as before, with
  its own approval card.

Nothing is stored, so there is nothing to migrate or clean up afterwards.

## What to watch

- `fill_secret` steps report `verified` or `failed`, and each carries a
  status for the secret: `pending`, `sent` (with the sites it was sent to), or
  `not_sent` with a reason (`in_url`, `other_origin`, `unsupported_encoding`,
  `left_without_secret`, `expired`, `interception_lost`, `removed`).
- A rise in `not_sent` on a site people rely on means that site's sign-in is
  one of the known limits below; the agent hands off to the person instead of
  retrying.
- `secrets_unavailable` while the feature is on means request interception
  could not be turned on for the tab; nothing was typed.
- The value must never appear in a log, an error, a tool result, or the
  conversation. Treat any sighting as a security bug and turn the feature off.

## Known limits

- A site that changes the secret in page script before sending it (hashing,
  encrypting, base64) never sends the placeholder. This is reported as
  `not_sent`, and the agent hands the sign-in to the person.
- WebSocket messages cannot be rewritten, so a secret is never swapped into
  one.
- Service workers and cross-origin iframes are separate from the page for
  interception. Their requests are not swapped and carry only the placeholder.
- One-time-code inputs that accept only digits, or only a few characters,
  reject the placeholder. The step reports `failed`.
- A site the secret is allowed for can send the secret back in a response,
  where that page's script can read it. Only list sites you trust with it.
- Secrets live in memory for one conversation on one computer. They are gone
  when OpenWork quits and are not shared with other conversations.

## Screenshots

<!-- screenshots: added by the orchestrator after the real-app run -->
