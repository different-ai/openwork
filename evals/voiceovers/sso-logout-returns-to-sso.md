# SSO logout return surface

1. A fresh browser signs in through the mock OIDC provider and reaches the OpenWork dashboard, proving the fixture exercises the real SSO callback path.

2. After logout, the browser returns to the organization SSO entry point. The old email-password login page stays hidden for this SSO-managed deployment.
