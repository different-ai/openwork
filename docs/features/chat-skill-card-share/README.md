# Share created skills in chat

- Feature key: `chatSkillCardShare` (`chat-skill-card-share.ts`).
- Deployments: cloud and self-hosted; off by default.
- Owner: `benjaminshafii`.

## What changes

A saved-skill result card offers **Share** beside **Open** when Library identifies
the signed-in member as the plugin's owner (owner role or a `mine` access edge).
Unknown permissions, non-owners and read-only transcripts have no Share action.
The dialog reuses Library's sharing page, including its organization-wide sharing
restriction. Saving rechecks the card's live audience without leaving chat.

Permission checks fetch only Library items, once per conversation's set of saved
plugins. The directory and grants load only when a dialog opens. Both queries and
the dialog are scoped to the signed-in identity and organization.

## Try it

Enable `chatSkillCardShare` for a development organization or member in `/admin`
→ Features. For a local self-hosted Den installation, set
`DEN_FEATURE_CHAT_SKILL_CARD_SHARE=true` on Den and restart it (the registered
operator override, not a separate client-side switch). Create a skill in chat,
click **Share**, select an audience, save, and confirm the access line updates.
Repeat as a non-owner and with the feature off: only **Open** remains.

## Turning it off

The action and any open sharing dialog disappear. Existing skills, grants and
Open-to-Library navigation remain unchanged; no data migration is involved.
An already submitted sharing request may still finish, as with Library sharing.

## Verification

`apps/app/tests/created-skill-render.test.tsx` covers ownership, the off state,
unknown permission, read-only cards, opening the existing dialog and refreshing
the card after a successful save. Real-product screenshot evidence is still
required before rollout (DESIGN.md P10). The local real-product attempt with
`pnpm world up dev-app-web --detach -- --browser` was blocked because the managed
OpenCode server exited with `Database is not empty and has no session table`;
no screenshot has been claimed for that failed run. Design rules: P5 (existing controls and
sharing UI), S4 (two inline actions), S5 (explicit opening), P11 (card retained).
The requested hidden permission state is an intentional exception to P4.
