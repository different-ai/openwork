# single-org-signup-policy — Enforce private signup and organization email domains

1. With single-org public signup disabled, the sign-in screen offers sign-in only—there is no account creation flow.

2. An anonymous email signup request is rejected server-side, and no user, session, or organization membership is created.

3. With public signup enabled and an allowed email domain configured, a matching user can register and join the single organization.

4. An out-of-domain signup is rejected before account creation, leaving no user, session, or membership records.

5. Multi-organization authentication behavior remains unchanged.
