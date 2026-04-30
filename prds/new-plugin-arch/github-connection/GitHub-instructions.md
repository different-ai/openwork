# GitHub Instructions

This document lists exactly what you need to configure for the GitHub App connection flow and where each value should go.

## Goal

After this setup:

1. You open `Integrations` in Den Web.
2. You click `Connect` on GitHub.
3. GitHub shows the GitHub App install flow.
4. GitHub redirects back to OpenWork.
5. OpenWork shows the repositories visible to that installation.
6. You select one repo.

## Where to put the local server values

Fill these values in:

`ee/apps/den-api/.env.local`

That file is loaded by Den API in this order:

1. `ee/apps/den-api/.env.local`
2. `ee/apps/den-api/.env`
3. existing shell environment

## Values you need from GitHub

You need to create or update a GitHub App and collect these values:

- GitHub App ID
- GitHub App Client ID
- GitHub App Client Secret
- GitHub App Private Key
- GitHub App Webhook Secret
- GitHub Installation ID
- Test repository ID
- Test repository full name (`owner/repo`)
- Test branch
- Test ref (`refs/heads/<branch>`)

## Exactly where each value goes

Put these in `ee/apps/den-api/.env.local`:

```env
# Required Den API basics
PORT=8790
OPENWORK_DEV_MODE=1
CORS_ORIGINS=http://localhost:3000,http://localhost:3001,http://localhost:3005
BETTER_AUTH_URL=http://localhost:8790
BETTER_AUTH_SECRET=<generate-a-32-plus-char-secret>
DEN_DB_ENCRYPTION_KEY=<generate-a-32-plus-char-secret>
DATABASE_URL=mysql://root:password@127.0.0.1:3306/den

# Existing user auth GitHub values. These are separate from the connector app.
GITHUB_CLIENT_ID=
GITHUB_CLIENT_SECRET=

# GitHub connector app values
GITHUB_CONNECTOR_APP_ID=<github-app-id>
GITHUB_CONNECTOR_APP_CLIENT_ID=<github-app-client-id>
GITHUB_CONNECTOR_APP_CLIENT_SECRET=<github-app-client-secret>
GITHUB_CONNECTOR_APP_PRIVATE_KEY=<github-private-key-with-escaped-newlines>
GITHUB_CONNECTOR_APP_WEBHOOK_SECRET=<github-webhook-secret>

# Handy local test values
GITHUB_TEST_INSTALLATION_ID=<installation-id>
GITHUB_TEST_REPOSITORY_ID=<repository-id>
GITHUB_TEST_REPOSITORY_FULL_NAME=<owner/repo>
GITHUB_TEST_BRANCH=main
GITHUB_TEST_REF=refs/heads/main
```

## Important private key formatting

For `GITHUB_CONNECTOR_APP_PRIVATE_KEY`, paste the private key as one line with `\n` escapes.

Example:

```env
GITHUB_CONNECTOR_APP_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\nMIIEv...\n-----END PRIVATE KEY-----
```

Do not paste raw multi-line PEM text directly unless you know the env loader path is handling it the way you expect.

## GitHub App setup

Go to:

`GitHub -> Settings -> Developer settings -> GitHub Apps -> New GitHub App`

Use these settings.

### Basic info

- App name: choose any unique name, for example `OpenWork Den Local`
- Homepage URL: use your local/public Den Web URL
  - local example: `http://localhost:3005`
  - public example: your deployed Den Web URL
- Description: optional

### Webhooks

- Webhooks: enabled
- Webhook URL:
  - for webhook deliveries themselves, use:
    - `https://<your-public-den-web-host>/api/den/v1/webhooks/connectors/github`
    - or the public Den API URL if you are not proxying through Den Web
- Webhook secret:
  - set this to the same value you put in `GITHUB_CONNECTOR_APP_WEBHOOK_SECRET`

## Important: Setup URL vs Webhook URL

GitHub App has two different relevant URLs:

1. `Setup URL`
2. `Webhook URL`

### Setup URL

This is where GitHub sends the user's browser back after installation.

This should be an actual Den Web page, not a den-api callback route.

Set it to:

`https://<your-public-den-web-host>/dashboard/integrations/github`

GitHub will append values like:

- `installation_id`
- `setup_action`
- `state`

Den Web reads those query params and then calls Den API to validate the signed state and load the repositories for that installation.

Do not point the Setup URL at Den API for this flow.

### Webhook URL

This is where GitHub sends push/install webhook events.

Set it to:

`https://<your-public-den-web-host>/api/den/v1/webhooks/connectors/github`

If your public entrypoint is Den API directly, use:

`https://<your-public-den-api-host>/v1/webhooks/connectors/github`

## Repository permissions

Set these GitHub App repository permissions:

- `Metadata`: `Read-only`
- `Contents`: `Read-only`

That is the minimum needed for the current repo-listing and validation flow.

## Organization permissions

None are strictly required for the current slice.

## Subscribe to these webhook events

Enable these events:

- `Push`
- `Installation`
- `Installation target`
- `Repository`

## Install the app

After creating the app:

1. Generate a client secret.
2. Generate a private key.
3. Install the app on the user or org that owns the repo you want to test.
4. Grant access to the repo you want to test.

## How to collect the values after setup

### App ID

From the GitHub App settings page.

Put in:

`GITHUB_CONNECTOR_APP_ID`

### Client ID

From the GitHub App settings page.

Put in:

`GITHUB_CONNECTOR_APP_CLIENT_ID`

### Client Secret

Generate from the GitHub App settings page.

Put in:

`GITHUB_CONNECTOR_APP_CLIENT_SECRET`

### Private Key

Generate from the GitHub App settings page.

Put in:

`GITHUB_CONNECTOR_APP_PRIVATE_KEY`

### Webhook Secret

From the GitHub App webhook configuration.

Put in:

`GITHUB_CONNECTOR_APP_WEBHOOK_SECRET`

### Installation ID

You can get it from the GitHub install redirect/callback, or via `gh`:

```bash
gh api repos/<owner>/<repo>/installation --jq '.id'
```

Put in:

`GITHUB_TEST_INSTALLATION_ID`

### Repository ID

```bash
gh api repos/<owner>/<repo> --jq '.id'
```

Put in:

`GITHUB_TEST_REPOSITORY_ID`

### Repository full name

Format:

`owner/repo`

Put in:

`GITHUB_TEST_REPOSITORY_FULL_NAME`

### Branch and ref

Examples:

- branch: `main`
- ref: `refs/heads/main`

Put in:

- `GITHUB_TEST_BRANCH`
- `GITHUB_TEST_REF`

## Local run commands

From the repo root:

```bash
pnpm --filter @openwork-ee/den-api dev
pnpm --filter @openwork-ee/den-web dev
```

Den Web default local URL in this repo is:

`http://localhost:3005`

Den API default local URL in this repo is:

`http://localhost:8790`

## Public URL requirement

GitHub must be able to reach your callback and webhook endpoints.

That means for real testing you need a public URL, usually via a tunnel or deployed environment.

Examples:

- `ngrok`
- `cloudflared`
- deployed Den Web / Den API host

## What to do after env is filled

1. Start Den API.
2. Start Den Web.
3. Confirm the GitHub App `Setup URL` points to the Den Web GitHub setup page.
4. Confirm the GitHub App `Webhook URL` points to the webhook endpoint.
5. Go to Den Web `Integrations`.
6. Click `Connect` on GitHub.
7. Finish the GitHub App install flow.
8. GitHub should return to `/dashboard/integrations/github` in Den Web.
9. Den Web should show the repository selection screen.

## Current scope note

This phase currently gets you to:

- GitHub App install redirect
- return to OpenWork
- repository list
- selecting one repo to create a connector instance

It does not yet complete full content ingestion from the selected repository.
