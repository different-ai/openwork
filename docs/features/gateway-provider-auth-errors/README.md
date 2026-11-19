# AI Gateway: rejected provider credentials in chat

> **GA:** Available without a feature flag. The former rollout key is retired.

- **Retired rollout key:** `gatewayProviderAuthErrors`
- **Deployments:** OpenWork Cloud and self-hosted
- **Author:** [benjaminshafii](https://github.com/benjaminshafii)

A generic upstream provider's 401 or 403 is
returned as a sanitized OpenWork Gateway error. For organization credentials,
chat tells the member that the provider rejected the organization's credential
and directs them to their administrator to check the connection in AI Gateway.
For member credentials, the message asks the member to sign in again or replace
their own credential. Both include a Gateway request ID in Technical details.
No upstream response body or credential is returned. Gateway usage is recorded
as an upstream error, with the upstream request ID retained in the request log
when available.

To try it, use a fake upstream that returns 401 or 403 in a test organization.
Provider API keys remain unchanged, and personal-provider 401 copy is not affected.
