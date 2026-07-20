# scim-requires-verified-sso — SCIM is safe to configure without causing an invalid SSO redirect

1. I open SCIM settings before SSO is configured. OpenWork explains that verified SSO is required and keeps SCIM disabled.

2. I configure and successfully test the organization’s SAML connection. The SCIM setup action is now available.

3. I enable SCIM and sign out. Returning with my existing non-SSO account no longer redirects me to a missing SSO provider merely because SCIM exists.

4. When SSO is explicitly required and the verified provider exists, OpenWork redirects matching users through the configured identity provider as expected.
