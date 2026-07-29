# SSO invite email prevalidation

1. We start with a real OpenWork invitation and show the invited email before SSO begins. This is the contract the identity-provider subject must satisfy.

2. Then the mock IdP intentionally returns a different email for the SSO subject. OpenWork must reject the mismatch coherently and stay out of the stale-cookie invite loop.
