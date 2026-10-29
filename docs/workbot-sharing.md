# Inviting coworkers

The copy-only Share Workbot control is removed. Its retired `workbotSharing`
setting is accepted and ignored for compatibility with older configuration;
it no longer advertises a share control in Workbot's session response.

Email invitations remain in Den's Members screen and on its
session-authenticated `/v1/invitations` route. `invitations.manage`, recent
sign-in, seat checks, delivery-error handling and invite acceptance are unchanged.
A Workbot MCP grant is not an invitation session and must not bypass those checks.

`workbot-sharing.proof.test.ts` checks that the removed entry and copy fallback
never appear, including with an older server's sharing hint, and that an owner
can still send an email invitation through Den. `workbot-sharing.api.test.ts`
checks the real invitation permission and recent-sign-in boundaries.
