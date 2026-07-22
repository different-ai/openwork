# on-sign-in-verify-name — prompt default-name users to identify themselves

1. A user signs in and lands on the OpenWork dashboard. Because their profile still says “OpenWork User,” OpenWork immediately opens a “User Profile” dialog instead of leaving the team with an indistinguishable default name.

2. The dialog explains, “Change how your name appears in the organization,” and shows two fields: First name and Last name. The Save button is disabled because nothing has changed yet.

3. The user edits one or both fields. Save becomes available as soon as the displayed name would change.

4. The user clicks Save. OpenWork updates the user’s profile name and closes the dialog, leaving the dashboard visible with the corrected name stored for the organization.

5. If the user clicks Cancel instead, the dialog closes without changing the name, and OpenWork does not prompt again during that same dashboard visit.
