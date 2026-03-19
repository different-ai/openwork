# OpenWork Cloud PR1/PR2 Flow Evidence

This document captures the user-visible flows unlocked by PR1 + PR2:

1. Create a Den account from the Den web app.
2. Reach the new OpenWork Cloud surface from the OpenWork app.
3. Enable developer mode to target a local/self-hosted Den control plane.
4. Sign into OpenWork Cloud from the OpenWork app.
5. See Den workers in the app.
6. Open a Den worker into OpenWork.

What is not unlocked yet:

- org invite / join UI
- org member management UI
- GitHub marketplace / repo publishing

Those belong to later work and are not claimed by this PR pair.

## Flow 1 - Create a Den account in the Den web app

Environment used:

- `packaging/docker/den-dev-up.sh`
- captured against the Docker-hosted Den web app

### Step 1 - Landing on the Den signup page

![Den signup start](./screenshots/den-flow/01-den-signup-start.png)

### Step 2 - Filling email and password

![Den signup filled](./screenshots/den-flow/02-den-signup-filled.png)

### Step 3 - Account created, worker naming step

![Den worker name step](./screenshots/den-flow/03-den-worker-name-step.png)

### Step 4 - Worker provisioning starts

![Den worker provisioning](./screenshots/den-flow/04-den-worker-provisioning.png)

### Step 5 - Signed-in dashboard with the first worker

![Den dashboard starting worker](./screenshots/den-flow/05-den-dashboard-starting-worker.png)

## Flow 2 - OpenWork app entry point for OpenWork Cloud

Environment used:

- `packaging/docker/dev-up.sh`
- captured against the Docker-hosted OpenWork app

### Step 1 - Default merged behavior points to hosted Cloud

This is the non-developer-mode experience after the latest adjustment. The app points to `https://app.openworklabs.com` and does not expose the Den endpoint override.

![OpenWork Cloud hosted default](./screenshots/openwork-cloud-flow/01-openwork-cloud-hosted-default.png)

### Step 2 - Developer mode is off by default

Developer mode must be enabled before the Den endpoint override appears.

![OpenWork advanced developer mode off](./screenshots/openwork-cloud-flow/02-openwork-advanced-enable-developer-mode.png)

### Step 3 - Developer mode enabled

Once enabled, the Debug tab appears and the app can target a local or self-hosted Den control plane.

![OpenWork developer mode enabled](./screenshots/openwork-cloud-flow/03-openwork-developer-mode-enabled.png)

### Step 4 - Cloud tab with local Den override visible

This is the developer-mode-only Cloud screen used for local validation.

![OpenWork Cloud developer mode signed out](./screenshots/openwork-cloud-flow/04-openwork-cloud-dev-signed-out.png)

### Step 5 - Local Den endpoint plus credentials entered

This is the sign-in form used during local validation of the app-side flow.

![OpenWork Cloud filled local Den sign-in](./screenshots/openwork-cloud-flow/05-openwork-cloud-filled-local-den-signin.png)

## Flow 3 - Signed into OpenWork Cloud, workers visible

Validation path:

- OpenWork app side validated in the Docker-hosted OpenWork app
- successful worker-list / worker-open proof captured from the same app surface against the Den-backed worker flow used in PR validation

### Step 6 - Signed in and worker list visible

![OpenWork Cloud worker list](./screenshots/openwork-cloud-flow/06-openwork-cloud-worker-list.png)

## Flow 4 - Open a Den worker inside OpenWork

### Step 7 - After clicking `Open`, the worker is active in OpenWork

![OpenWork Cloud worker opened](./screenshots/openwork-cloud-flow/07-openwork-cloud-worker-opened.png)

## Notes

- The OpenWork app screenshots prove the PR1/PR2 app behavior: Cloud tab, developer-mode endpoint override, sign-in, worker listing, and `Open`.
- The Den web screenshots prove account creation and first-worker initialization in the Docker Den stack.
- Org invite / join screenshots are intentionally absent because no invite/member-management UI ships in PR1/PR2.
