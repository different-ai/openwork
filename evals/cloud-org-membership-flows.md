# Cloud org membership flows

End-to-end user flows for organization membership, invitations, roles, and org
switching from the user's desktop perspective.

## Preflight

1. Start Daytona Den server and Electron sandboxes.
2. Sign in as an org owner in the desktop app.
3. Create or select an org dedicated to the eval.

## Flow 1: Invite teammate and accept

**Goal:** An owner invites a teammate, the teammate accepts, and the owner can see
the updated org membership through desktop-connected cloud state.

### Steps

1. As owner, create an invitation through Den Web or Den API.
2. Create/sign in as the invited user.
3. Accept the invite.
4. In the owner desktop app, refresh Cloud Account or fetch `/v1/org` from the Electron renderer.

### Expected outcome

- The invitation returns an invite token/id.
- The invited user becomes a member of the org.
- Owner-side cloud state shows the additional member.
- Den API logs show invitation creation and acceptance requests.

## Flow 2: Role update propagates

**Goal:** Changing a member role server-side is visible to desktop-connected org
state.

### Steps

1. Complete Flow 1.
2. As owner, update the invited member role through Den API.
3. In Electron, fetch or refresh org context.

### Expected outcome

- The member role changes in `/v1/org`.
- If the member is signed in on another desktop instance, Cloud Account reflects the changed role after refresh.

## Flow 3: Remove member

**Goal:** Removing a member from the org revokes their cloud access.

### Steps

1. Sign in as a member in a second Electron profile or sandbox.
2. As owner, remove that member through Den API.
3. In the member desktop app, refresh Cloud Account, Cloud Providers, and Settings -> Extensions marketplace.

### Expected outcome

- Member no longer has active org context.
- Cloud Providers and Settings -> Extensions marketplace stop returning org resources for that org.
- The UI shows a clear signed-in-but-no-org or access removed state.

## Flow 4: Org switch sync

**Goal:** A user in multiple orgs sees resources update after switching active
org.

### Setup

Create two orgs. Add a uniquely named provider and marketplace to each.

### Steps

1. Sign in as a user belonging to both orgs.
2. Select Org A in Cloud Account.
3. Verify Org A provider/marketplace names appear.
4. Select Org B.
5. Verify Org B provider/marketplace names appear and Org A-only names disappear.

### Expected outcome

- Active org selection persists in local storage.
- Cloud provider and marketplace requests use the active org context.
- Workspace-imported cloud resources are reconciled for the selected org.

## Flow 5: Invitation domain restriction

**Goal:** Organization email-domain restrictions are enforced and visible to the
user.

### Steps

1. Set `allowedEmailDomains` for an org.
2. Try inviting an address outside the allowed domains.
3. Try accepting an invite with an account outside the allowed domains.

### Expected outcome

- Invite creation or acceptance fails with a clear domain restriction message.
- No member row is created for the rejected account.
