---
name: cloud-dashboard-walkthrough
description: Drive the OpenWork Cloud dashboard (Den Web / app.openworklabs.com) as a real user via headless Chrome CDP — sign up, create an org, invite teammates, teams, plugins with skills, marketplaces, team access grants, desktop handoff. Use for cloud tutorials, dashboard screenshots, demo walkthroughs, or when a task says "create an org / invite teammates / create a plugin / assign a marketplace" on OpenWork Cloud.
---

# Cloud Dashboard Walkthrough (Den Web via CDP)

Drive the real OpenWork Cloud dashboard end-to-end as a user. Proven flow used
to produce `packages/docs/cloud/team-quickstart.mdx` — reuse it for
tutorial refreshes, demos, and screenshot runs.

## Stack setup

Start a Den server sandbox (multi-org, dev mode skips email verification):

```bash
bash .devcontainer/test-server-on-daytona.sh dev --name <sandbox-name>
# capture the printed DEN_WEB_URL and DEN_API_URL
```

`start-daytona-server.sh` must pass `DEN_ORG_MODE` to **den-web** (not just
den-api); otherwise den-web defaults to `single_org` with private signup and
the UI silently routes new emails to the password step. Verify:

```bash
curl -s "$DEN_WEB_URL/api/runtime-config"   # expect "orgMode":"multi_org"
```

Launch a driver Chrome (2x screenshots, isolated profile):

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9223 \
  --user-data-dir=/tmp/opencode/chrome-profile \
  --window-size=1440,960 --force-device-scale-factor=2 \
  --hide-scrollbars --disable-gpu about:blank &
```

Then use `browser_navigate` / `browser_eval` / `browser_screenshot` with
`browser_url: "http://127.0.0.1:9223"`. The a11y snapshot is sparse in
headless — drive everything through `browser_eval` DOM queries instead.

## Driving patterns (React/Next)

- **Inputs**: set values through the native setter so React sees them:

  ```js
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  set.call(input, "value"); input.dispatchEvent(new Event("input", { bubbles: true }));
  ```

  (Use `HTMLTextAreaElement.prototype` for textareas.)
- **Buttons**: match on exact trimmed text. Beware prefix collisions — the
  submit "Sign up" vs "Sign **up with Google**" (clicking the latter on a
  sandbox yields "Provider not found").
- **Before every screenshot**: hide the Next.js dev badge —
  `document.querySelector('nextjs-portal')?.style.display = 'none'` — and wait
  ~1s for settle. Dev-only UI is safe to hide; never hide product UI.
- Tab labels carry count badges (`Teams2`): match with
  `el.textContent.trim().replace(/\d+$/, "")`.

## The flows (routes + exact labels)

| Step | Route | Key labels |
|---|---|---|
| Email-first sign-in | `/` | "Start using OpenWork" → EMAIL → **Next** |
| Sign-up | `/` | "Create your account." → EMAIL/NAME/PASSWORD → **Sign up** |
| Create org | `/organization` | "Name your team." → Organization name → **Continue** |
| Onboarding checklist | `/dashboard/onboarding` | "Let's finish setting up {org}." |
| Members / invites | `/dashboard/members` | **Add member** → Email + Role → **Send invite**; rows show INVITED/Pending |
| Teams | `/dashboard/members` Teams tab | **Create Team** → name (placeholder "Core Engineering") + member card toggles → **Create team** |
| Plugins list | `/dashboard/plugins` | **Create plugin** |
| Plugin editor | `/dashboard/plugins/new` | name/description → **+ Skill** (name, one-line description, markdown instructions) → Share: org-wide checkbox + **Marketplace** select → **Create plugin** |
| Marketplaces | `/dashboard/marketplaces` | **New marketplace** → Name + Description → **Create marketplace** |
| Marketplace access | `/dashboard/marketplaces/<id>` Members tab | "Who can access this": Everyone toggle, **Add team**, **Add people** |

Notes:

- The plugin editor pre-selects the first marketplace in the Share section —
  create your marketplace *before* the plugin.
- Skills are stored as SKILL.md-style config objects; write instructions as a
  plain markdown runbook.
- **Security check**: changing marketplace access triggers a sudo modal
  ("For security, confirm it's you…"). Fill `input[type="password"]`, click
  **Verify password**; the pending action retries automatically.
- **Seat limit**: invites beyond 5 members return 402 and open the
  "Subscribe to add more users" dialog (free tier = 5 seats).

## Teammates actually joining

Invite tokens are readable as the owner: `GET /api/den/v1/org` →
`invitations[].token`. Join link: `/join-org?invite=<token>`.

- **Browser path** (for "what the teammate sees" screenshots): second Chrome
  profile on another port → open join link → set password → **Join {org}**.
- **API path** (fast): `POST $DEN_API_URL/api/auth/sign-up/email` with the
  invited email (dev mode returns a token immediately), then
  `POST /v1/orgs/invitations/accept` with `Authorization: Bearer <token>` and
  body `{"id":"<inviteToken>"}`.
- Accounts created through the join flow get the default name "OpenWork User";
  fix via `PATCH /api/den/v1/me/profile` `{"firstName":"…","lastName":"…"}`
  from that user's session.

## Desktop handoff grants

As a signed-in web user: `POST /api/den/v1/auth/desktop-handoff` (body `{}`)
→ `{ grant }`. Build the deep link yourself — the server-resolved
`denBaseUrl` can be an internal host:

```
openwork://den-auth?grant=<grant>&denBaseUrl=<urlencoded DEN_WEB_URL>
```

Grants expire in 5 minutes and are single-use. Consuming it in Electron is
covered in the `daytona-electron-den` skill.

## Daytona preview URLs expire

Public preview URLs get auth-walled after a while (redirect to Auth0 →
fetches fail / "Not found."). Recovery:

```bash
daytona sandbox preview-url <sandbox> -p 3005 --expires 86400   # den-web
daytona sandbox preview-url <sandbox> -p 8788 --expires 86400   # den-api
```

Then **restart the Den stack with the signed URLs as its public URLs** —
Better-Auth rejects the new host with 403 "Invalid origen" otherwise (trusted
origens are derived from the public URLs at startup). Re-run
`start-daytona-server.sh` inside the sandbox with
`DEN_WEB_PUBLIC_URL`/`DEN_API_PUBLIC_URL` set to the signed URLs. Browser
cookies do not carry across hosts — sign in again.

## daytona exec quirk

The CLI eats flag-like tokens inside commands (`mkdir -p`, `tail -30` lose
their flags). Prefer flag-free forms (`cd /workspace && mkdir x`,
`cat file | tail`) or pipe the file to stdout and process locally.
