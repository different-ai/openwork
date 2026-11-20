# Admin security check recovery

- Key: `adminSecurityCheckRecovery`
- Deployments: cloud and self-hosted, off by default
- Author: `benjaminshafii`

When a workspace security check is cancelled, the page offers **Confirm it's you** to reopen it without pressing Save again. **Discard pending change** clears the queued work. Pending changes are kept only in page memory and discarded when leaving the page or switching workspaces/accounts.

For a session started through SSO, SSO stays first; a password is offered as a fallback only for an account with a password when SSO is not required. An unavailable SSO action explains why it cannot be used.

To try it, enable the feature for a test workspace, sign in through SSO and let the admin freshness window pass. Change a workspace setting, cancel the security check, then choose **Confirm it's you** and sign in again. Check that the original save finishes. Test both SSO-only and optional-SSO settings. Turning off the feature restores the previous prompt and cancellation behavior. Neither setting changes the server's permission or freshness checks.

Browser verification and screenshots are not yet available.
