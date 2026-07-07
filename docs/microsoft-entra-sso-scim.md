# Microsoft Entra SSO and SCIM

This guide connects Microsoft Entra ID to an OpenWork organization for SAML
single sign-on and SCIM user provisioning.

## How OpenWork is wired

OpenWork uses Better Auth for the underlying SSO and SCIM protocol handlers, then
wraps them with organization-scoped OpenWork routes and policy:

| Area | OpenWork surface | Runtime behavior |
|---|---|---|
| SSO management | `/dashboard/sso`, `/v1/sso`, `/v1/sso/saml`, `/v1/sso/oidc` | One SSO connection per organization. Owners and security admins can create or replace it. |
| SAML callback | `/api/auth/sso/saml2/sp/acs/openwork-sso-<org-id>` | Better Auth consumes the response after OpenWork validates SAML response policy. |
| SAML metadata | `/api/auth/sso/saml2/sp/metadata?providerId=openwork-sso-<org-id>` | Generated after the SAML connection is saved in OpenWork. |
| SSO sign-in | `/sso/<org-slug>` | Starts SP-initiated SSO for the organization and redirects to Entra. |
| SCIM management | `/dashboard/scim`, `/v1/scim`, `/v1/scim/token` | Owners and security admins create or rotate an org-scoped SCIM bearer token. |
| SCIM provisioning | `/api/auth/scim/v2` | Supports SCIM user provisioning, updates, and deprovisioning. |

OpenWork enforces these SAML security settings for organization SSO:

- Signed SAML assertions are required.
- IdP-initiated SAML is disabled.
- SAML timestamps are required.
- Deprecated SAML algorithms are rejected.
- SSO login writes an external identity link and just-in-time organization
  membership.
- Email/password sign-in is rejected for users managed by an organization SSO or
  SCIM connection.

OpenWork does not currently support SCIM Group object provisioning. You can
assign Entra users and groups to the enterprise application for scope, but keep
the Entra group object mapping disabled.

## Prerequisites

- An OpenWork organization owner or admin with security configuration access.
- A Microsoft Entra account with permission to manage Enterprise applications.
  Microsoft documents this as Cloud Application Administrator, Application
  Administrator, or owner of the service principal for SSO configuration.
- The public OpenWork web and auth URLs must already be final HTTPS URLs. SAML
  and browser auth cookies should not be validated against temporary HTTP
  origins in production.
- The OpenWork organization should have the expected email domain configured in
  organization settings before requiring SSO for that domain.
- The OpenWork organization must have the SSO/Enterprise entitlement enabled.
  Without it, OpenWork keeps the form editable but rejects save attempts with
  `SSO / SAML requires an Enterprise plan`.

## Create or select the Entra enterprise application

1. Open the Microsoft Entra admin center.
2. Go to **Entra ID** -> **Enterprise apps** -> **All applications**.
3. Select the existing OpenWork enterprise application, or create a new
   non-gallery enterprise application for OpenWork.
4. Assign at least one test user or test group under **Users and groups**.

For the OpenWork Labs test tenant, use:

- **Tenant ID**: `2b853de0-b14b-4433-90be-cced1b963647`
- **OpenWork SSO domain**: `omaropenworklabs.onmicrosoft.com`
- **Test users**:
  - `omar2@omaropenworklabs.onmicrosoft.com`
  - `omar_openworklabs.com#EXT#@omaropenworklabs.onmicrosoft.com`
- **OpenWork organization**: `Omar Azure Test`

As of July 7, 2026, both test users are assigned to the **OpenWork Labs**
enterprise application in Entra, and the OpenWork Cloud org has the Enterprise
entitlement needed to save SSO settings.

## Configure SAML SSO

There is a small handoff between Entra and OpenWork: OpenWork needs Entra's IdP
values before it can save the connection, and Entra needs OpenWork's generated
ACS URL before SAML can be fully tested.

1. In the Entra enterprise application, open **Single sign-on** and choose
   **SAML**.
2. In the Entra SAML page, copy these IdP values:
   - **Microsoft Entra Identifier**. Use this as OpenWork **Issuer URL**.
   - **Login URL**. Use this as OpenWork **SAML Entry Point**.
   - **Certificate (Base64)**. Paste the PEM certificate into OpenWork
     **IdP Certificate**.
3. In OpenWork, open **Dashboard** -> **SSO** and choose **SAML**.
4. Fill the OpenWork fields:
   - **Issuer URL**: the Entra **Microsoft Entra Identifier**.
   - **Domain**: the email domain that should use this SSO connection, for
     example `example.com`.
   - **SAML Entry Point**: the Entra **Login URL**.
   - **Audience URL**: leave blank to use the OpenWork auth URL, or enter a
     stable Entity ID that you will also set as the Entra Identifier.
   - **IdP Certificate**: the Entra Base64 certificate as PEM text.
5. Save the SSO connection in OpenWork.
   - For a custom domain such as `example.com`, request the domain verification
     TXT token in OpenWork, publish it in DNS, then click **Verify domain**.
   - For Microsoft tenant domains ending in `.onmicrosoft.com`, OpenWork
     verifies the domain from the matching Entra tenant issuer and SAML entry
     point. You do not need to publish DNS records under Microsoft's
     `onmicrosoft.com` zone.
6. Copy the generated OpenWork values:
   - **ACS URL**.
   - **Metadata URL**.
   - **Sign-in URL**.
7. Return to Entra **Single sign-on** -> **Basic SAML Configuration** and set:
   - **Identifier (Entity ID)**: the OpenWork audience. If you left the
     OpenWork audience blank, use the OpenWork auth URL shown by your deployment
     docs or metadata.
   - **Reply URL (Assertion Consumer Service URL)**: the OpenWork **ACS URL**.
   - **Sign on URL**: the OpenWork **Sign-in URL**.
8. Save the Entra SAML configuration.
9. In Entra **Attributes & Claims**, make sure OpenWork receives:
   - `email`: the user's email address, usually `user.mail` with fallback to
     `user.userprincipalname` in tenants where `mail` is empty.
   - `displayName`: the user's display name.
   - Name ID: an email-like stable user identifier.
10. Test with an assigned user from the OpenWork `/sso/<org-slug>` URL. This is
    the supported SP-initiated path.

For the OpenWork Labs test tenant, the OpenWork SAML fields are:

- **Issuer URL**:
  `https://sts.windows.net/2b853de0-b14b-4433-90be-cced1b963647/`
- **Domain**: `omaropenworklabs.onmicrosoft.com`
- **SAML Entry Point**:
  `https://login.microsoftonline.com/2b853de0-b14b-4433-90be-cced1b963647/saml2`
- **Audience URL**: leave blank unless you also set a custom Entra Identifier.
- **IdP Certificate**: paste the active Entra SAML signing certificate.

## Configure SCIM user provisioning

1. In OpenWork, open **Dashboard** -> **SCIM**.
2. Copy the **SCIM base URL**.
3. Create or rotate the connector token and copy the bearer token immediately.
   OpenWork only shows it after creation or rotation.
4. In the Entra enterprise application, open **Provisioning**.
5. Set **Provisioning Mode** to **Automatic**.
6. Under **Admin Credentials**, set:
   - **Tenant URL**: the OpenWork **SCIM base URL**.
   - **Secret Token**: the OpenWork SCIM bearer token.
7. Select **Test Connection**.
8. Open **Mappings**:
   - Keep user provisioning enabled.
   - Disable group object provisioning. OpenWork currently returns `501` for
     SCIM `/Groups`.
   - Use a matching attribute that OpenWork can filter by, normally
     `userName` mapped from `userPrincipalName` or `mail`.
9. Under **Settings**, choose the scope. For a controlled rollout, sync only
   assigned users and groups.
10. Turn **Provisioning Status** on after the test connection and mappings are
    correct.

## Validation checklist

- Entra SAML test redirects through OpenWork's `/sso/<org-slug>` URL.
- The SAML response lands on OpenWork's generated ACS URL.
- A first SSO login creates or updates an OpenWork user and organization member.
- Email/password sign-in is rejected for managed users when SSO is required for
  the organization domain.
- Entra SCIM **Test Connection** succeeds.
- Provisioning an assigned test user creates the OpenWork user and organization
  membership.
- Removing the assignment deprovisions organization access without deleting the
  global OpenWork user record.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Entra says the reply URL is invalid | The Entra Reply URL does not match OpenWork's generated ACS URL | Copy the ACS URL from OpenWork after saving the SAML connection and paste it into Basic SAML Configuration. |
| SAML login fails with audience or recipient errors | Entra Identifier, OpenWork Audience URL, or ACS URL do not match | Keep the Entra Identifier equal to the OpenWork audience and the Entra Reply URL equal to the OpenWork ACS URL. |
| SAML login fails after changing certs | OpenWork still has the old IdP certificate | Paste the new Entra Base64 certificate into OpenWork and save the SAML connection again. |
| IdP-initiated login fails | OpenWork only supports SP-initiated organization SAML | Start login from OpenWork's `/sso/<org-slug>` sign-in URL. |
| SCIM test connection is unauthorized | The token was copied incorrectly or rotated after Entra was configured | Rotate the OpenWork SCIM token and update Entra's Secret Token. |
| Entra group provisioning fails | OpenWork does not support SCIM Group objects yet | Disable the group object mapping and use group assignment only to scope user provisioning. |

## References

- Microsoft: Enable SAML single sign-on for an enterprise application:
  https://learn.microsoft.com/en-us/entra/identity/enterprise-apps/add-application-portal-setup-sso
- Microsoft: Manage automatic user account provisioning:
  https://learn.microsoft.com/en-us/entra/identity/app-provisioning/configure-automatic-user-provisioning-portal
- Microsoft: Develop and plan provisioning for a SCIM endpoint:
  https://learn.microsoft.com/en-us/entra/identity/app-provisioning/use-scim-to-provision-users-and-groups
- Microsoft: Customize provisioning attribute mappings:
  https://learn.microsoft.com/en-us/entra/identity/app-provisioning/customize-application-attributes
- Better Auth SSO plugin:
  https://better-auth.com/docs/plugins/sso
- Better Auth SCIM plugin:
  https://better-auth.com/docs/plugins/scim
