# join-org-already-joined — Clicking an invite you already accepted opens your workspace

Invited teammates — especially on SSO or single-org deployments where sign-in auto-accepts the invite — used to hit a dead-end "This invite has already been used." every time they clicked their invite email.

1. The admin invites a new teammate; the teammate clicks the emailed link and lands on the redesigned invite card — organization, invited email, and role visible, with account creation right there.

2. The teammate sets a password and joins; the workspace welcomes them in.

3. The teammate clicks the same emailed invite link again — instead of the old "This invite has already been used." dead-end, OpenWork recognizes the membership and opens the team workspace.

4. In a fresh browser session, the same link now says they’ve already joined and asks them to sign in — not an error.

5. They sign in and land straight in the workspace; the invite email keeps working as a door into the team forever.

6. Later the admin removes the teammate. Signing in again doesn’t quietly restore access anymore — and the old invite now says plainly that access was removed, instead of pretending the invite was used up.

7. A fresh invite from the admin opens the door again: one click and the teammate is back in the workspace, with their original membership picked up right where it left off.
