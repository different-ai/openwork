# invite-adoption-no-duplicates — Invites become one member, never a duplicate

This internal proof follows the Den API outputs and the den-web Members page for a tagged Riley invite. The reviewer sees the same table states an admin would see: pending invite, duplicate bug shape, and the final clean row.

1. The first frame shows Alex's Members page after inviting Riley as an admin. Riley is visible as a pending invite, and the API output beside the screenshot confirms the invitation and invited placeholder both carry the admin role.

2. The next frame shows Riley's account creation and first sign-in, then names the org mode the local stack is running. In single-org mode the first sign-in already becomes the headline proof: one active Riley member with role admin, the invite accepted, and no invited ghost; in multi-org mode Riley is still outside the workspace and the admin invite remains pending.

3. The third frame is the customer-reported bad state on the Members page. One Riley row is an active member with the wrong member role, while the pending invited admin row is still visible beside it.

4. The final frame is the repaired Members page after Riley signs in again. The duplicate is gone: there is one Riley row, the role is admin, and the API output confirms the invitation is accepted with no invited placeholder left behind.
