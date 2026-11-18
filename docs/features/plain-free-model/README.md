# OpenWork Free listed like any other model

> **Generally available:** `plainFreeModel` is retired; the enabled behavior is now standard. Permissions, organization settings and entitlements still apply. Any rollout, off-state or kill-switch instructions below describe the historical rollout; see [the retirement guide](../ga-rollout-retirement/README.md).

- **Feature key:** `plainFreeModel`
- **Deployments:** cloud and self-hosted
- **Author:** benjaminshafii
- **Default:** off
- **Ticket:** ENG-964

## What changes

With the feature on, the free model (provider `openwork-free`, model
`openai/gpt-6-luna`, internally "Auto") is no longer special in the model
picker:

- Its row uses the same name source, icon and meta line as every other model:
  it reads **GPT-6 Luna** (the engine's own title) with the maker's logo,
  instead of "OpenWork Free" with the OpenWork mark and a "Free with a usage
  limit" / "Limit used up" subtitle.
- It is never disabled or greyed out because of its usage limit or status, and
  the picker no longer shows the "limit used up" notice under the list.
  Shortcuts and the command palette can switch to it too.
- The composer's model button shows the same name.

When the limit is used up, the person can still pick it. Sending is refused
by the existing preflight, and the chat shows the usual OpenWork Free message
(for example "You’ve used OpenWork Free for now · It’s back on Monday") with
the gateway code under Technical details, exactly as before for a send that
hit the limit.

Unchanged: the free model is still hidden when it is switched off for the
service or covered by the organization's OpenWork Models, and the
"Finishing setup" notice still shows while OpenWork Models sync.

## How to try it

1. Turn `plainFreeModel` on for an organization in `/admin` (or for everyone,
   which also covers signed-out desktops through `GET /v1/features`).
2. Use OpenWork Free until its allowance is used up (or point the desktop at a
   gateway fixture that answers `free_allowance_exhausted`).
3. Open the model picker: GPT-6 Luna is listed and selectable. Send a message:
   the chat shows the limit message.

## Turning it off

The picker goes back to the "OpenWork Free" row, which is disabled with
"Limit used up" when the allowance is gone. Nothing is stored by the feature,
so a conversation already on the free model keeps working either way.

## What to watch

More refused sends for the free model (rejected turns with an Auto access
wall in the chat), and support reports of people confused by the limit
message after choosing GPT-6 Luna.
