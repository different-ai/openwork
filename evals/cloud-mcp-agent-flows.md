# Cloud MCP agent flows

End-to-end flows where the **agent itself** (composer prompts) operates OpenWork
Cloud through the `openwork-cloud` MCP. These validate the real product story:
a signed-in user types plain English and the agent manages their org.

All flows verified 2026-06-09 against a local Den stack (MySQL + den-api +
den-web, seeded demo org) with the desktop dev app signed in as the org owner
and the cloud MCP auto-configured (first-party token). Ground truth asserted
via Den API/DB, not just the transcript.

## Preflight

1. Start the Den stack and seed the demo org (`seed:demo-org`, login
   `alex@acme.test`). For invitation flows the org needs seat headroom: either
   fewer members than the free seat count or an active `seat` row in
   `org_subscriptions`.
2. Point the desktop at the Den stack (desktop-bootstrap.json), reload the
   renderer after changing the bootstrap (boot can race and keep stale base
   URLs in localStorage), then sign in via paste-code.
3. Open Settings -> Extensions -> MCP and wait for **OpenWork Cloud Control —
   Ready** (auto-sync mints the token and the entry hot-connects without an
   engine reload).
4. A working model provider must be configured (flows below ran on
   `openwork/kimi-k2.6`).

## Flow 1: Which cloud am I connected to

**Prompt:** "Which OpenWork Cloud organization am I connected to? Use your
openwork-cloud tools to check."

**Expected:** agent calls `getV1Org` / `getV1Me` and answers with the org name,
slug, the signed-in user, and their role.

**Verified result:** "You are connected to the Acme Robotics organization
(slug: acme-robotics-demo). You are signed in as Alex Chen (alex@acme.test)
and have the owner role."

## Flow 2: Invite a member

**Prompt:** "Add omar@openworklabs.com to my organization as a member using
your openwork-cloud tools."

**Expected:**
- If the email's domain is not allowed, the agent first updates the org's
  allowed email domains (observed: it did this autonomously).
- If the org is at its free seat limit, the agent surfaces the billing
  requirement instead of failing silently (observed: clear seat-limit
  explanation with counts).
- With seats available: `POST /v1/invitations` 201.

**Assert (ground truth):** `invitation` row with the email, `role: member`,
`status: pending`.

## Flow 3: Assign a member to a team

**Prompt:** "Assign <member> to the Sales team using your openwork-cloud tools."

**Expected:**
- For a **pending invitee**, the agent refuses with a correct explanation
  (only active members can join teams) — observed.
- For an active member: team membership created.

**Assert:** `team_member` row joins the member to the Sales team.

## Flow 4: Create a skill locally and share it via plugin + marketplace

**Prompt:** "Create a skill called 'weekly-report' (...instructions...) and
save it as a proper SKILL.md in this workspace. Then share it with my whole
organization using the proper OpenWork Cloud way: create a plugin containing
the skill and publish it to our marketplace."

**Expected:**
- `.opencode/skills/weekly-report/SKILL.md` written in the workspace (the
  "Skills changed. Reload to apply." toast appears).
- Cloud side: plugin created, skill config object attached
  (`sourceMode: cloud`), plugin attached to the marketplace, org-wide viewer
  grants on plugin + config object.

**Assert:** `plugin`, `plugin_config_object` (+`config_object` of type skill),
`marketplace_plugin`, and `*_access_grant` rows with `org_wide=1, role=viewer`.

**Known trap (observed):** the agent may create a *duplicate marketplace*
instead of reusing the existing one, leaving the plugin invisible to other
members (the duplicate has creator-only grants). The marketplace-create tool
description now steers agents to list-and-reuse; when grading, check the
plugin landed in a marketplace **other members can see**.

## Flow 5: The invited member sees the shared plugin

**Steps:** the invited user (Flow 2) creates an account, accepts the
invitation, then resolves the org marketplace (this is exactly what the
desktop app consumes).

**Assert:** `GET /v1/marketplaces/:id/resolved` as the new member contains the
plugin from Flow 4 with its skill content.

**Verified result:** omar (fresh account → accepted invite) sees
`weekly-report` in OpenWork Marketplace.

## Grading notes

- Always assert server-side effects (API/DB), never just the transcript.
- Business-rule refusals (seat limits, pending invitees) count as PASS when
  explained correctly — they prove the MCP surfaces real org policy.
- Watch for resource duplication (marketplaces, plugins) when re-running:
  prompts are not idempotent.
