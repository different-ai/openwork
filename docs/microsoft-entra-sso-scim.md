# Microsoft Entra SSO and SCIM

This guide connects Microsoft Entra ID to an Micx organization for SAML
single sign-on and SCIM user provisioning.

## How Micx is wired

Micx uses Better Auth for the underlying SSO and SCIM protocol handlers, then
wraps them with organization-scoped Micx routes and policy:

| Area | Micx surface | Runtime behavior |
|---|---|---|
| SSO management | `/dashboard/sso`, `/v1/sso`, `/v1/sso/saml`, `/v1/sso/oidc` | One SSO connection per organization. Owners and security admins can create or replace it. |
| SAML callback | `/api/auth/sso/saml2/sp/acs/micx-sso-<org-id>` | Better Auth consumes the response after Micx validates SAML response policy. |
| SAML metadata | `/api/auth/sso/saml2/sp/metadata?providerId=micx-sso-<org-id>` | Generated after the SAML connection is saved in Micx. |
| SSO sign-in | `/sso/<org-slug>` | Starts SP-initiated SSO for one organization and redirects to Entra. |
| SCIM management | `/dashboard/scim`, `/v1/scim`, `/v1/scim/token` | Owners and security admins create or rotate an org-scoped SCIM bearer token. |
| SCIM provisioning | `/api/auth/scim/v2` | Supports SCIM user provisioning, updates, and deprovisioning. |

Micx enforces these SAML security settings for organization SSO:

- Signed SAML assertions are required.
- IdP-initiated SAML is accepted only through the org-specific provider ACS URL.
- SAML timestamps are required.
- Deprecated SAML algorithms are rejected.
- SSO login writes an external identity link and just-in-time organization
  membership.
- Email/password sign-in is rejected for users managed by an organization SSO or
  SCIM connection.

Micx does not currently support SCIM Group object provisioning. You can
assign Entra users and groups to the enterprise application for scope, but keep
the Entra group object mapping disabled.

## Prerequisites

- An Micx organization owner or admin with security configuration access.
- A Microsoft Entra account with permission to manage Enterprise applications.
  Microsoft documents this as Cloud Application Administrator, Application
  Administrator, or owner of the service principal for SSO configuration.
- The public Micx web and auth URLs must already be final HTTPS URLs. SAML
  and browser auth cookies should not be validated against temporary HTTP
  origins in production.
- The Micx organization should have the expected email domain configured in
  organization settings before requiring SSO for that domain.
- The Micx organization must have the SSO/Enterprise entitlement enabled.
  Without it, Micx keeps the form editable but rejects save attempts with
  `SSO / SAML requires an Enterprise plan`.

## Create or select the Entra enterprise application

1. Open the Microsoft Entra admin center.
2. Go to **Entra ID** -> **Enterprise apps** -> **All applications**.
3. Select the existing Micx enterprise application, or create a new
   non-gallery enterprise application for Micx.
4. Assign at least one test user or test group under **Users and groups**.

For the Micx Labs test tenant, use:

- **Tenant ID**: `2b853de0-b14b-4433-90be-cced1b963647`
- **Micx SSO domain**: `omarmicxlabs.onmicrosoft.com`
- **Test users**:
  - `omar2@omarmicxlabs.onmicrosoft.com`
  - `omar_micxlabs.com#EXT#@omarmicxlabs.onmicrosoft.com`
- **Micx organization**: `Omar Azure Test`

As of July 7, 2026, both test users are assigned to the **Micx Labs**
enterprise application in Entra, and the Micx Cloud org has the Enterprise
entitlement needed to save SSO settings.

## Configure SAML SSO

There is a small handoff between Entra and Micx: Micx needs Entra's IdP
values before it can save the connection, and Entra needs Micx's generated
ACS URL before SAML can be fully tested.

1. In the Entra enterprise application, open **Single sign-on** and choose
   **SAML**.
2. In the Entra SAML page, copy these IdP values:
   - **Microsoft Entra Identifier**. Use this as Micx **IdP Issuer URL**.
   - **Login URL**. Use this as Micx **SAML Entry Point**.
   - **Certificate (Base64)**. Paste the PEM certificate into Micx
     **IdP Certificate**.
3. In Micx, open **Dashboard** -> **SSO** and choose **SAML**.
4. Fill the Micx fields:
   - **IdP Issuer URL**: the Entra **Microsoft Entra Identifier**. This is
     the IdP issuer, not the Entra app's Identifier / Entity ID.
   - **Domain**: the email domain that should use this SSO connection, for
     example `example.com`.
   - **SAML Entry Point**: the Entra **Login URL**.
   - **Audience URL**: leave blank to use the Micx auth URL, or enter a
     stable Entity ID that you will also set as the Entra Identifier.
   - **IdP Certificate**: the Entra Base64 certificate as PEM text.
5. Save the SSO connection in Micx.
   - For a custom domain such as `example.com`, request the domain verification
     TXT token in Micx, publish it in DNS, then click **Verify domain**.
   - For Microsoft tenant domains ending in `.onmicrosoft.com`, Micx
     verifies the domain from the matching Entra tenant issuer and SAML entry
     point. You do not need to publish DNS records under Microsoft's
     `onmicrosoft.com` zone.
6. Copy the generated Micx values:
   - **ACS URL**.
   - **Metadata URL**.
   - **Sign-in URL**.
7. Return to Entra **Single sign-on** -> **Basic SAML Configuration** and set:
   - **Identifier (Entity ID)**: the Micx audience. If you left the
     Micx audience blank, use the Micx auth URL shown by your deployment
     docs or metadata. Do not use the Entra `https://sts.windows.net/.../`
     issuer here.
   - **Reply URL (Assertion Consumer Service URL)**: the Micx **ACS URL**.
   - **Sign on URL**: the Micx **Sign-in URL**.
8. Save the Entra SAML configuration.
9. In Entra **Attributes & Claims**, make sure Micx receives:
   - `email`: the user's email address, usually `user.mail` with fallback to
     `user.userprincipalname` in tenants where `mail` is empty.
   - `displayName`: the user's display name.
   - Name ID: an email-like stable user identifier.
10. Test with an assigned user from the Micx `/sso/<org-slug>` URL or the
    Entra My Apps tile. For multi-org users, the org slug, Entra app, and ACS
    URL choose which Micx organization they are entering.

For the Micx Labs test tenant, the Micx SAML fields are:

- **IdP Issuer URL**:
  `https://sts.windows.net/2b853de0-b14b-4433-90be-cced1b963647/`
- **Domain**: `omarmicxlabs.onmicrosoft.com`
- **SAML Entry Point**:
  `https://login.microsoftonline.com/2b853de0-b14b-4433-90be-cced1b963647/saml2`
- **Audience URL**: leave blank unless you also set a custom Entra Identifier.
  With the field blank, set Entra **Identifier (Entity ID)** to the Micx
  auth URL, not to the `sts.windows.net` issuer.
- **IdP Certificate**: paste the active Entra SAML signing certificate.

## Configure SCIM user and group provisioning

1. In Micx, open **Dashboard** -> **SCIM**.
2. Copy the **SCIM base URL**.
3. Create or rotate the connector token and copy the bearer token immediately.
   Micx only shows it after creation or rotation.
4. In the Entra enterprise application, open **Provisioning**.
5. Set **Provisioning Mode** to **Automatic**.
6. Under **Admin Credentials**, set:
   - **Tenant URL**: the Micx **SCIM base URL**.
   - **Secret Token**: the Micx SCIM bearer token.
7. Select **Test Connection**.
8. Open **Mappings**:
    - Keep user provisioning enabled.
    - Enable group object provisioning when Entra groups should manage Micx teams.
    - Use a matching attribute that Micx can filter by, normally
      `userName` mapped from `userPrincipalName` or `mail`.
9. In Micx, enable **Create teams from SCIM groups** if provisioned groups
   should create and manage matching teams. Leave it off to retain group metadata
   without changing teams.
10. Under **Settings**, choose the scope. For a controlled rollout, sync only
   assigned users and groups.
11. Turn **Provisioning Status** on after the test connection and mappings are
    correct.

## Validation checklist

- Micx's `/sso/<org-slug>` Sign-in URL redirects to Entra for SP-initiated
  SSO.
- Entra My Apps or test launch posts the SAML response to Micx's generated
  ACS URL.
- A first SSO login creates or updates an Micx user and organization member.
- Email/password sign-in is rejected for managed users when SSO is required for
  the organization domain.
- Entra SCIM **Test Connection** succeeds.
- Provisioning an assigned test user creates the Micx user and organization
  membership.
- Provisioning a group creates a matching Micx team when team sync is enabled.
- Removing the assignment retains a disconnected member record. Micx deletes
  the global user only when the user has no other active organization membership.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Entra says the reply URL is invalid | The Entra Reply URL does not match Micx's generated ACS URL | Copy the ACS URL from Micx after saving the SAML connection and paste it into Basic SAML Configuration. |
| Microsoft shows `AADSTS700016` for `https://sts.windows.net/.../` | Entra is receiving the IdP issuer as the SP Entity ID / app identifier | Set Entra **Identifier (Entity ID)** to the Micx audience/auth URL, then resave the SSO connection in Micx so AuthnRequests use the Micx SP Entity ID. |
| SAML login fails with audience or recipient errors | Entra Identifier, Micx Audience URL, or ACS URL do not match | Keep the Entra Identifier equal to the Micx audience and the Entra Reply URL equal to the Micx ACS URL. |
| SAML login fails after changing certs | Micx still has the old IdP certificate | Paste the new Entra Base64 certificate into Micx and save the SAML connection again. |
| IdP-initiated login fails with `unsolicited_response` | The deployment is running an older Micx version that rejects IdP-initiated SAML | Upgrade Micx or start login from Micx's `/sso/<org-slug>` sign-in URL. |
| SCIM test connection is unauthorized | The token was copied incorrectly or rotated after Entra was configured | Rotate the Micx SCIM token and update Entra's Secret Token. |
| Entra group provisioning fails | Micx does not support SCIM Group objects yet | Disable the group object mapping and use group assignment only to scope user provisioning. |

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
