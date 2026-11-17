# LiteLLM: member Microsoft Entra sign-in

Feature key: `litellmEntraMemberSignIn` (cloud and self-hosted, off by default).
Author: `benjaminshafii`.

## What changes

Some organizations run LiteLLM with JWT auth only (`enable_jwt_auth`,
`litellm_jwtauth`) and turn LiteLLM virtual keys (`sk-…`) off. The three
existing LiteLLM modes all need a LiteLLM key, so those proxies could not be
added to AI Gateway.

With the feature on, **AI Gateway › AI Providers › Add a provider › LiteLLM**
offers a fourth choice, **Microsoft sign-in**:

- The admin enters the proxy URL, a dedicated Entra app registration
  (directory (tenant) ID, application (client) ID, client secret), one API
  scope such as `api://<app-id>/access`, and the list of model names people
  may use. OpenWork never holds a LiteLLM key for this provider and never
  reads the proxy's models, teams or keys.
- Each allowed person selects **Connect** in the OpenWork app and signs in
  with Microsoft once (authorization code + PKCE, the same flow as Microsoft
  Foundry member sign-in). Den stores their tokens encrypted.
- AI Gateway renews the access token with the stored refresh token and sends
  the person's own Entra **access token** as `Authorization: Bearer …` to
  LiteLLM, which validates it (JWKS, issuer, audience).

Nothing changes for Microsoft Foundry sign-in or for the three key-based
LiteLLM modes, with the feature on or off.

## Who it is for

Organizations whose LiteLLM proxy accepts identity-provider tokens instead of
LiteLLM keys, with Microsoft Entra ID as the identity provider.

## How to try it

1. Turn `litellmEntraMemberSignIn` on for the organization in `/admin`.
2. In Entra, register an app, expose an API scope on it, set
   `requestedAccessTokenVersion` to `2` in its manifest, and create a client
   secret. Configure LiteLLM's JWT auth with that tenant's v2.0 issuer and the
   app's client ID as an audience. The published guide has every step:
   `packages/docs/ai-gateway/litellm.mdx` ("Microsoft sign-in").
3. Add the provider in AI Gateway with **Microsoft sign-in**, save, and add
   the redirect URI shown on the provider page to the Entra app registration.
4. In the OpenWork app, choose one of the provider's models and select
   **Connect**. Sign in with Microsoft. The models become usable.

## What turning it off does

- No new LiteLLM provider can be added in this mode, and an existing one's
  sign-in settings and model list cannot be changed (`404 feature_disabled`).
- **Connect** stops: the connect page says Microsoft sign-in for this provider
  is turned off and that an admin can turn it back on.
- People who already signed in keep their models. AI Gateway keeps renewing
  and forwarding their token until it is revoked. To cut access immediately,
  disable or remove the provider on its page; both work with the feature off.
- Stored tokens and settings are kept, so turning the feature back on restores
  everything without anyone signing in again.

## What to watch

- Den API log line `gateway_oauth_callback_failed` with `method: "microsoft"`:
  a sign-in that Entra or OpenWork refused. The `code` says why
  (`oauth_invalid_client`: the app registration's client ID or secret is
  wrong or expired; `oauth_refresh_token_required`: `offline_access` was not
  granted).
- AI Gateway `401 openwork_auth_required` for the provider: the person's
  refresh token no longer works and they need to **Connect** again.
- LiteLLM answering `401` to requests that reach it: the token is forwarded
  but LiteLLM's issuer or audience does not match it. See the troubleshooting
  table in the published guide.

Tokens and the client secret are never logged and never returned by any API.

## Not covered by automated tests

The flow is unit and API tested against fakes. It has not been run against a
real Entra tenant or a real LiteLLM proxy.
