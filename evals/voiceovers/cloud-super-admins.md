# Cloud super admins - enforce a clear organization role hierarchy

1. The sidebar documents the workspace areas clearly: Extensions contains Marketplace, Sources, Plugins, and Connectors; Models contains OpenWork Models and LLM Providers; Members and Analytics stand alone; Settings contains General, Diagnostics, Brand appearance, Desktop Policies, Stripe, API Keys, SSO, and SCIM.

2. Signed in as an admin, I can create and manage resources throughout Extensions and Models, manage teams, invite people, remove eligible members, and use Analytics. I cannot change anyone's role.

3. Admins can open every Settings page and read the organization's configuration, diagnostics, policies, billing, API keys, SSO, and SCIM state. Every setting and mutating action is disabled, and direct API requests to change settings are rejected too.

4. As the owner, I promote an admin or member to super-admin. Multiple admins and multiple super-admins can exist in the same workspace.

5. Signed in as a super-admin, I can modify everything available in the sidebar, including organization configuration, branding, desktop policies, billing, Models, API keys, SSO, and SCIM. I can also change member roles and remove members, admins, or other super-admins.

6. The owner account remains protected: nobody can delete it or change its role. Ownership is the only capability reserved exclusively for the current owner.

7. As the owner, I transfer ownership to a super-admin. The selected person becomes the sole owner, and the previous owner automatically becomes a super-admin.

8. The access guide summarizes enforcement across both the application and API: owners control ownership, super-admins control all organization administration and settings, admins manage operational resources and invitations but only read Settings, and members use assigned workspace resources.
