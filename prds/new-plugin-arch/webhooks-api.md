# New Plugin Arch Webhooks API

This document covers public webhook ingress and internal async sync trigger shapes.

Normal authenticated admin APIs are documented in `prds/new-plugin-arch/admin-api.md`.

## Principles

- public webhooks are separate from authenticated admin APIs;
- signature verification happens before parsing or processing;
- ingress should be fast and queue-driven;
- connector-specific reconciliation happens asynchronously.

## Public webhook endpoints

### GitHub webhook ingress

- `POST /v1/webhooks/connectors/github`

Purpose:

- receive GitHub App webhook deliveries for connector sync and connector lifecycle events.

Expected request inputs:

- raw request body
- `X-Hub-Signature-256`
- `X-GitHub-Event`
- `X-GitHub-Delivery`

Behavior:

1. verify signature against raw body
2. reject invalid/missing signatures with `401`
3. normalize the webhook envelope
4. dispatch by event type
5. enqueue sync jobs for relevant branch updates
6. return quickly

Recommended responses:

- `401 Unauthorized` for invalid signature
- `202 Accepted` for relevant accepted events
- `200 OK` for valid but ignored events

## Internal webhook dispatch

Recommended normalized envelope:

```ts
type GithubWebhookEnvelope = {
  deliveryId: string
  event: string
  installationId?: number
  repositoryId?: number
  repositoryFullName?: string
  ref?: string
  headSha?: string
  payload: unknown
}
```

Recommended internal handlers:

- `githubWebhookIngress()`
- `handleGithubPushEvent()`
- `handleGithubInstallationEvent()`
- `handleGithubInstallationRepositoriesEvent()`
- `handleGithubRepositoryEvent()` optional later

## Signature verification shape

Requirements:

- use the GitHub App webhook secret;
- compute HMAC SHA-256 from the raw body;
- compare using constant-time comparison;
- do not parse JSON before verification;
- do not process if signature fails.

Practical rule:

- no signature match, no webhook processing.

Example pseudocode:

```ts
async function githubWebhookIngress(req: Request) {
  const rawBody = await req.text()
  const signature = req.headers.get("x-hub-signature-256")

  if (!signature) return new Response("missing signature", { status: 401 })

  const expected = signGithubBody(rawBody, env.GITHUB_CONNECTOR_APP_WEBHOOK_SECRET)
  if (!timingSafeEqual(signature, expected)) {
    return new Response("invalid signature", { status: 401 })
  }

  const event = req.headers.get("x-github-event")
  const deliveryId = req.headers.get("x-github-delivery")
  const payload = JSON.parse(rawBody)

  return dispatchGithubWebhook({ event, deliveryId, payload })
}
```

## Internal sync enqueue contract

For relevant push events on tracked branches, enqueue an async sync job.

Recommended payload shape:

```ts
type GithubConnectorSyncJob = {
  connectorType: "github"
  connectorInstanceId: string
  connectorTargetId: string
  connectorSyncEventId: string
  deliveryId: string
  installationId: number
  repositoryId: number
  repositoryFullName: string
  ref: string
  headSha: string
}
```

Recommendations:

- dedupe on `connectorTargetId + headSha`
- preserve `deliveryId` for observability
- allow internal retries without requiring webhook redelivery
- installation lifecycle events may update connector-account health/state without enqueuing a content reconciliation job

## Worker result contract

The worker should update `connector_sync_event` with:

- final status (`completed`, `failed`, `partial`)
- target id
- head SHA
- created / updated / deleted / skipped counts
- per-file failures if any
- completed timestamp

## Related docs

- `prds/new-plugin-arch/GitHub-connector.md`
- `prds/new-plugin-arch/admin-api.md`
