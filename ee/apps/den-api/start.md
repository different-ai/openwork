# OpenWork — Agent Onboarding (start.md)

This is the cold-start contract for an **agent** onboarding a user into OpenWork
Cloud (Den) with no human in the loop. Every step below is a plain REST call
against the Den API. Read this file, then drive the calls in order.

> Base URL: the Den API origin (self-hosted or hosted), e.g. `https://den.example.com`.
> All request/response bodies are JSON.

## The model: unverified, but usable

An **unverified** account is a first-class citizen. It can:

- sign up,
- create its **own** organization,
- invite teammates,
- install the desktop app and add marketplace skills.

The single hard boundary: an unverified account **cannot JOIN an organization
owned by someone else**. Accepting an invitation requires a verified email. This
keeps signup open and agent-friendly while ensuring an unverified actor can only
ever affect its own sandbox org.

## Flow

### 1. Sign up (headless, no browser)

```
POST /api/auth/sign-up/email
{ "name": "Ada Agent", "email": "ada@example.com", "password": "<generated>" }
```

Creates an unverified account. Keep the returned session token (or sign in next).

### 2. Sign in

```
POST /api/auth/sign-in/email
{ "email": "ada@example.com", "password": "<same>" }
```

Use the returned bearer token as `Authorization: Bearer <token>` for all `/v1/*`
calls below.

### 3. Create your own organization (allowed while unverified)

```
POST /v1/org
{ "name": "Ada's Workspace" }
-> 201 { "organization": { "id": "...", "slug": "...", ... } }
```

### 4. Invite teammates (allowed while unverified)

```
POST /v1/invitations
{ "email": "teammate@example.com", "role": "admin" }
```

### 5. Join an existing org — requires a VERIFIED email

```
POST /v1/orgs/invitations/accept
{ "id": "<invitationId>" }
```

- Verified account -> `200 { "accepted": true, ... }`
- Unverified account -> `403 { "error": "email_verification_required",
  "message": "Verify your email address before joining an organization." }`

If you receive `email_verification_required`, guide the user to verify their
email (or complete email-OTP), then retry the accept call.

### 6. Continue setup

With an org in place, the agent can install the desktop app, connect a
workspace, and add skills from the marketplace — the user is fully set up.

## Notes for agents

- Treat `403 email_verification_required` as a *pause-and-guide* signal, never a
  hard failure: creating an org and inviting people do not require verification,
  only joining someone else's org does.
- All steps are idempotent-friendly: re-running signup with an existing email
  returns an error you can fall back to sign-in for.
