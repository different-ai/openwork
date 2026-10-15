# Headless model attribution

- Feature: `headlessModelAttribution`
- Deployments: cloud and self-hosted; off by default
- Author: `benjaminshafii`

This is inference cost attribution and governance metadata, not product analytics.
Den resolves an active organization membership when issuing a turn's credentials.
The runner optionally sends that identity to its configured inference endpoint using
`HEADLESS_MODEL_USER_HEADER` and `HEADLESS_MODEL_USER_HEADER_FORMAT` (default
`member_id`; alternatives `user_id`, `owner`, and explicitly opted-in `email`).
No header configuration or no issued identity means no attribution header. Identity
is per-turn credential data, not prompt content or persisted transcript data.
Reserved authentication/routing headers and unsafe values are rejected. Inference
redirects are refused so neither credentials nor attribution follow another host.

## Try it

Enable the feature for a test organization/member and configure the runner with
`HEADLESS_MODEL_USER_HEADER=X-Member-Id`. Send concurrent turns as two active
members to a recording inference gateway. Each request, including streaming and
title calls, must carry its originating member ID. Remove the header setting or
disable the feature: newly issued credentials must send no header. Resume/refresh
must replace old identity rather than retaining it when fresh credentials omit it.
Use only fictional members in recordings. Watch upstream request headers and
errors; never log real tokens, prompts, or email addresses.

## Rollback and scope

Turning the feature off stops identity issuance for new credentials. Already issued
turn credentials remain valid until refreshed or the turn ends; there is no
synchronous revocation of an in-flight HTTP request. Disabling runner header
configuration prevents header emission regardless of issued identity.

The header is metadata for a trusted external gateway, not proof of identity for
OpenWork's own gateway. OpenWork gateway identity, grants, usage and budgets are
bound to its authenticated member key; a shared key plus this header does not
change that identity. General attribution headers are not automatically forwarded
through OpenWork's gateway. Any future upstream mapping there should derive its
value from authenticated gateway membership, not a caller-supplied header.
