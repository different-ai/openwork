# SSO misconfiguration contract checks

1. First we recreate the certificate paste mistake from the field. The lab catches the trailing newline as its own named SSO configuration error, so the fix is obvious instead of a generic sign-in failure.

2. Next we recreate the wrong-domain setup mistake. The lab compares the IdP subject domain to the configured organization domain and names the mismatch before anyone is sent through a broken SSO route.
