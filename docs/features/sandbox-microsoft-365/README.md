# Sandboxes: sample Microsoft 365 for Workbot (`sandboxMicrosoft365`)

> **Generally available:** `sandboxMicrosoft365` is retired; the enabled behavior is now standard. It remains cloud-only. Permissions, organization settings and entitlements still apply. Any rollout, off-state or kill-switch instructions below describe the historical rollout; see [the retirement guide](../ga-rollout-retirement/README.md).

- **Key:** `sandboxMicrosoft365`
- **Deployments:** cloud only (sandbox organizations are cloud only)
- **Default:** off
- **Author:** @benjaminshafii

## What changes

Sandbox organizations (`/admin/sandbox-orgs`) connect the hosted sample work apps (Open Outlook, Open Calendar,
Open Drive, Open Jira, Open Confluence). Until now each app was a separate generic MCP connector. Workbot's chat,
Calendar tab, Documents tab and first hello use Den's **native Microsoft 365** routes, so in a sandbox they found
no calendar or mail ("I couldn't find your calendar or email").

With the feature on, a **new** sandbox gets one native **Microsoft 365** connector instead of the three separate
Outlook, Calendar and Drive connectors (Jira and Confluence stay MCP connectors). It signs in at the sandbox's own
sample work apps, not Microsoft:

1. When the sandbox is created, Den registers itself with the workplace as an ordinary confidential OAuth client
   (`POST <workplace>/_workshop/microsoft/clients`, Den's exact callback URL). No secret is configured anywhere.
2. Each member presses **Connect** once (from Workbot's welcome, or their connections). The workplace's consent page
   opens in their browser and shows the private sample workspace that browser already has, the same one they see in
   Open Outlook/Calendar/Drive and the one the Jira/Confluence connectors use.
3. Den stores the member's token as usual. Every Microsoft 365 route (mail, calendar, files, documents, drafts,
   events) then calls the workplace's Graph front door (`<workplace>/v1.0`) instead of `graph.microsoft.com`.

Per-member isolation is the workplace's: one private workspace per browser profile. People sharing a browser profile
share a workspace (as with the existing sample connectors).

## Why production Microsoft is untouched

Endpoints are decided per OAuth client, on every read, from things only Den sets
(`ee/apps/den-api/src/capability-sources/sandbox-microsoft-endpoints.ts`):

- the client carries the `openWorkplaceSandbox` marker, written only by sandbox setup (organization admins can change
  a client's ID, secret, tenant and features, never other settings);
- the organization is an **open** sandbox, and the address is the workplace address a platform admin gave it;
- the feature is on for the organization.

Every other organization and connector keeps the registry's Microsoft endpoints. The process-wide
`DEN_MICROSOFT_*` overrides are not used.

## Turning it off

The kill switch (or turning it off for an organization) makes the sample connector **unavailable**: sign-in returns
"Sample Microsoft 365 is turned off for this sandbox." and the routes answer `409 needs_connection` with that
message. Den never falls back to sending the sample client or tokens to Microsoft. Turning it back on restores the
connector without reconnecting. When a sandbox closes or expires, the same happens with "This sandbox has ended".

Sandboxes created while the feature was off keep their separate connectors. To give an existing sandbox the
connector, turn the feature on for its organization, then use **Add Microsoft 365** on its row in
`/admin/sandbox-orgs` (`POST /v1/admin/sandbox-orgs/:id/microsoft-365`). Its old Outlook/Calendar/Drive connectors are
kept for an admin to remove.

If the workplace has no Microsoft 365 sign-in yet (an older deployment of the workshop), sandbox creation logs
`sandbox microsoft 365 failed` and falls back to the separate connectors.

## Requirements

- The workplace runs `evals/packages/open-workplace/src/workshop.mjs` from this change or later (`GET /health`
  reports `microsoftSignIn: true`).
- `DEN_API_PUBLIC_URL` is set, so the callback Den registers is the one members return to.

## Try it

- API: `pnpm --filter @openwork-ee/den-api exec node --conditions=development --import tsx --test test/api/sandbox-microsoft-365.api.test.ts`
- Workshop: `node --test evals/packages/open-workplace/src/workshop-microsoft.test.mjs`
- End to end (Den web, real browser consent, Workbot's Calendar route): `evals/proofs/sandbox-microsoft-365.proof.test.ts`

## What to watch

- Den logs: `sandbox microsoft 365 failed` (registration with the workplace failed; the sandbox got separate
  connectors instead).
- `409 needs_connection` from `/v1/capabilities/microsoft-365/*` in sandbox organizations.
