# scim-groups-to-teams — SCIM groups manage OpenWork teams without compromising SAML sign-in or membership history

1. An organization admin sees that SAML sign-in and SCIM provisioning are both active, with SCIM group synchronization available for team management.

2. The admin enables Create teams from SCIM groups, making it clear that the identity provider will manage those teams and memberships.

3. After the identity provider sends its groups, OpenWork shows matching teams such as Engineering and Design, marked Managed by SCIM.

4. A user signs in through SAML and arrives as an organization member already assigned to the Engineering team provisioned by SCIM.

5. When the identity provider moves the user from Engineering to Design, OpenWork updates their team memberships without requiring another login.

6. OpenWork removes only SCIM-managed team memberships during group synchronization, preserving teams and memberships that administrators manage manually.

7. When SCIM removes a user who still belongs to another organization, OpenWork preserves the global user while retaining a disconnected, removed member record for this organization.

8. When SCIM removes a user with no other active organization memberships, OpenWork deletes the global user while retaining the disconnected member record and preventing SAML from silently restoring deprovisioned access.
