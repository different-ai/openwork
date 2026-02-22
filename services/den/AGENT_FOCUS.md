# Agent Focus: Den Service + Polar Gate

This guide explains how agents should operate, test, and troubleshoot the Den service.

## What this service does

- Handles auth (`/api/auth/*`) and session lookup (`/v1/me`).
- Creates workers (`/v1/workers`) and provisions cloud workers on Render.
- Optionally enforces a Polar paywall for cloud worker creation.

## Core flows to test

### 1) Auth flow

1. `POST /api/auth/sign-up/email`
2. `GET /v1/me` using cookie session
3. `GET /v1/me` using Bearer token from sign-up response

Expected: all succeed with `200`.

### 2) Cloud worker flow (no paywall)

Set `POLAR_FEATURE_GATE_ENABLED=false`.

1. `POST /v1/workers` with `destination="cloud"`
2. Confirm `instance.provider="render"`
3. Poll `instance.url + "/health"`

Expected: worker creation `201`, worker health `200`.

### 3) Cloud worker flow (paywall enabled)

Set all Polar env vars and `POLAR_FEATURE_GATE_ENABLED=true`.

For a user without entitlement:

1. `POST /v1/workers` with `destination="cloud"`

Expected:

- `402 payment_required`
- response contains `polar.checkoutUrl`

For an entitled user (has the required Polar benefit):

1. `POST /v1/workers` with `destination="cloud"`

Expected: worker creation `201` with Render-backed instance.

## Required env vars (summary)

- Base: `DATABASE_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`
- Render: `PROVISIONER_MODE=render`, `RENDER_API_KEY`, `RENDER_OWNER_ID`, and `RENDER_WORKER_*`
- Polar gate:
  - `POLAR_FEATURE_GATE_ENABLED`
  - `POLAR_ACCESS_TOKEN`
  - `POLAR_PRODUCT_ID`
  - `POLAR_BENEFIT_ID`
  - `POLAR_SUCCESS_URL`
  - `POLAR_RETURN_URL`

## Deployment behavior

`dev` is the production branch for this service. Workflow:

- `.github/workflows/deploy-den.yml`

It updates Render env vars and triggers a deploy for the configured service ID.

## Common failure modes

- `provisioning_failed`: Render deploy failed or health check timed out.
- `payment_required`: Polar gate is enabled and user does not have the required benefit.
- startup error: paywall enabled but missing Polar env vars.
