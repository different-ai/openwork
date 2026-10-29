# Diagnostics

**Settings › Diagnostics** is one page for every Den deployment: OpenWork Cloud,
single-organization installs and multi-organization self-hosted installs. It
answers three questions before anyone files a ticket:

- Do people's desktop apps start and connect to OpenWork, and how fast?
- Is each AI provider set up correctly against its endpoint, before anyone sends a prompt?
- Are the installation's services working? (self-hosted installation administrators)

The same data is available as one endpoint, `GET /v1/org/diagnostics`, for
smoke tests after a deploy.

Diagnostics never block startup, upgrades, requests or running work. A failing
check is information, not an authorization decision. There is no feature flag.

## Who sees what

Each section is either shown or locked for the viewer. A locked section stays on
the page and says what permission it needs (DESIGN.md P4).

| Section | Who can see it |
| --- | --- |
| Desktop app | `desktop_policies.view` |
| AI providers | `gateway_providers.view` (or `llm_providers.view` for legacy providers when the AI Gateway is off) |
| Connectors | `connections.view` |
| Installation | Self-hosted: installation administrators only. Cloud: shows "Managed by OpenWork". |
| Advanced › Network check | `egress_diagnostics.view` (running it needs `egress_diagnostics.manage`) |

**Installation administrators** are the people on the installation's local
administrator allowlist. Successful signed `/setup` bootstrap enrolls the first
one; `DEN_BOOTSTRAP_ADMIN_EMAILS` seeds more. Organization ownership, admin roles
and ownership transfers never grant installation access. An installation
administrator with an ordinary member role still sees Settings › Diagnostics,
but only the sections their organization permissions allow plus Installation.
On OpenWork Cloud nobody gets installation details from this page, including
OpenWork's own platform admins (they use **Admin › Services**).

## Desktop app

Each desktop app launch sends one small report to the organization's Den after
it connects (or when it fails). It records milliseconds from process start to:

1. **Window open**
2. **Engine ready** (the local OpenCode engine)
3. **Signed in to OpenWork** (first successful authenticated call to Den)
4. **Org tools loaded** (OpenWork Connect capabilities and organization connections)

A failed launch records the step it stopped at and a fixed reason code
(`certificate`, `dns`, `offline`, `timeout`, `connection_refused`,
`server_error`, `session_expired`, `signed_out`, `engine_failed`,
`org_unavailable`, `unknown`). If Den couldn't be reached, the app keeps the
report and sends it after the next successful connection, so certificate and
DNS problems still show up. Reports contain the app version, platform, step
timings and the reason code: no paths, URLs, emails or message content. People
who were never signed in send nothing.

The page shows the last 24 hours: launches, the typical (median) and slowest
(95th percentile) time to connected, time spent in each step, failures grouped
by step and reason with how many people were affected, and app versions.
Reports older than 30 days are deleted.

## AI providers

For each provider the organization configured, Den checks the endpoint with the
stored organization credential **without sending a prompt**:

| Provider | Check |
| --- | --- |
| OpenAI, OpenAI-compatible, Mistral, OpenRouter, Azure OpenAI | `GET /models` (Azure: deployments) |
| Anthropic | `GET /v1/models` |
| Google AI Studio | `GET /v1beta/models` |
| LiteLLM | `GET /v1/models` with the stored key, plus the last sync result |
| Amazon Bedrock (access keys) | AWS STS `GetCallerIdentity`: proves the key, not model access |
| Vertex, Microsoft Foundry, Bedrock API keys, Mantle | No check that avoids a model request; shown as not checked |
| Member sign-in providers | Never probed with a member's credential; shows connected and needs-attention counts |
| OpenWork Models | Managed by OpenWork |

Results: **Ready** (models listed), **Key rejected** (401/403), **Unreachable**,
**Model missing** (a configured model the endpoint doesn't serve),
**Misconfigured**. Requests use the inference egress guard (public addresses,
no redirects, operator allowlist). Live results are cached per organization for
10 minutes and a new live check is admitted at most every 30 seconds.

## Connectors

- **Slack assistant:** installed, the bot token accepted by Slack (`auth.test`,
  nothing posted), last event received (within the 7-day event retention) and
  answers completed in the last 24 hours.
- **Google Workspace:** which Google APIs the connector's permissions need are
  enabled, checked with the viewer's own sign-in. Den never uses another
  member's token.

## Installation (self-hosted)

| Service | Check |
| --- | --- |
| OpenWork server | Version, when this replica started, and how long it took to accept connections |
| Database | A real query |
| AI Gateway | Fixed health and readiness endpoints, including its database check |
| Headless runner | Versioned, service-authenticated health response. Resumable answers are shown as a detail: callback settings match, not set up, or incomplete (incomplete marks the runner misconfigured) |
| Workbot | Service-authenticated response; compares its Den origin with this deployment's |
| Email | SMTP: connect, TLS and sign in, then disconnect. Resend: the key is accepted and the `EMAIL_FROM` domain is verified (a send-only key proves the key but can't list domains). No message is sent |

Every service shows how long its check took. Technical details name settings,
never their values. Checks use only operator-configured origins and fixed paths;
callers can't supply destinations or credentials. **Check now** is rate limited
and shared across replicas when Redis is configured; without Redis, results are
per replica.

Slack assistant and resumable answers used to be separate deployment services.
They could never be verified at the deployment level, so they always showed
"Couldn't verify". Slack is now checked per organization under Connectors, and
resumable answers are a detail of the headless runner.

## Endpoint

```bash
curl -H "Authorization: Bearer $OPENWORK_API_KEY" \
  "https://den.example.com/v1/org/diagnostics?strict=1"
```

- Sessions and organization API keys are accepted. The Installation section is
  filled for an installation administrator's session or API key.
- `?strict=1` answers `503` when any item in `attention` has severity `error`,
  otherwise `200`. The body is the same either way.
- `POST /v1/org/diagnostics/check` starts the checks the caller may run and
  returns `202`, or `429` with `Retry-After` when every refresh was rate limited.
- `POST /v1/diagnostics/desktop-startup` is the desktop app's report endpoint.

This page shares Den's authentication and database. If Den itself can't serve
authenticated requests, use the `/health` and `/ready` probes and deployment
logs.
