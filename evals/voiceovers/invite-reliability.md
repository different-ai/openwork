# Invite reliability

1. Alex starts from the cloud dashboard, creates a fresh test workspace, and sees Den Web pinned to that new organization before inviting anyone.

2. Alex opens Members, sends Jamie a real invitation, and the pending row appears with Jamie's exact eval email.

3. Jamie accepts the invitation in a separate Chrome profile, lands in the same workspace, and sees that the join completed without touching the desktop app.

4. Jamie opens the same accepted invite link again, and the product lands her in a coherent already-member state instead of a blank or broken page.

5. Alex reloads the member list and verifies Jamie appears exactly once, proving the invite did not duplicate or attach to the wrong organization.

6. A garbage invite token opens the real invite screen error state, clearly explaining that the invite cannot be opened instead of looping or going blank.

7. Alex removes Jamie, sends a fresh invite to the same email with an explicit admin role, and Jamie accepts that new invite from her browser.

8. Alex returns to Members and sees Jamie's accepted row with the Admin role, proving the re-invite preserved the requested role.

9. The eval cleans up Jamie's membership and records that the Electron desktop cell is intentionally skipped unless a desktop-specific eval sets its own gate.
