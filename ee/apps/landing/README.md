# OpenWork Landing (Next.js)

## Local dev

1. Install deps from repo root:
   `pnpm install`
2. Run the app:
   `pnpm --filter @openwork-ee/landing dev`

### Optional env vars

- `NEXT_PUBLIC_CAL_URL` - enterprise booking link
- `LOOPS_API_KEY` - Loops API key for enterprise contact submissions
- `LANDING_FORM_ALLOWED_ORIGINS` - optional comma-separated origin allowlist for feedback/contact form posts

### Contact and feedback forms (Plain)

Both `/contact` and `/feedback` submit to `/api/app-feedback`. Following
[Plain's contact form flow](https://www.plain.com/docs/product/channels/contact-forms),
the server upserts a customer by email and creates a thread containing only the
user's message. Diagnostic context is stored in thread fields. Existing customer
profiles are preserved, and new email addresses are marked unverified.
The SDK transport sends minimal mutations selecting only IDs and error codes.
Avoid the generated `PlainClient.mutation` helpers here: they also select related
company, user, and machine-user records and can fail with HTTP 403 when the key
has only the form's customer/thread permissions.
Plain automatically derives companies from customer email domains; the form does
not explicitly create companies or override company assignments.

Before enabling the forms in a deployment:

1. In Plain, open **Settings → Machine Users**, create a machine user, and add
   an API key with `customer:create`, `customer:edit`, `customer:read`,
   `thread:create`, `thread:read`, and `threadField:create` permissions.
2. Set `PLAIN_API_KEY` in the landing app's server environment (for local dev,
   use `ee/apps/landing/.env.local`). Never use a `NEXT_PUBLIC_` variable for it.
3. Configure [email sending](https://www.plain.com/docs/product/channels/email-sending)
   and [email receiving](https://www.plain.com/docs/product/channels/email-receiving)
   in Plain for `team@openworklabs.com` so the team can reply from Plain and
   receive follow-up emails there. This also routes the forms' direct email link
   into Plain.
4. Submit each form and verify the thread, customer email, diagnostic context,
   and email reply flow in Plain.

#### Structured feedback context

The initial thread entry contains only the user's message. Available OS, app
version, and deployment are stored as separate [Plain thread fields](https://www.plain.com/docs/product/platform/threads/thread-fields)
for filtering. Everything else is stored as formatted JSON in a single Text field.

| Plain field key | Label | Type |
| --- | --- | --- |
| `openwork_os_name` | OpenWork OS | Text |
| `openwork_app_version` | OpenWork app version | Text |
| `openwork_deployment` | OpenWork deployment | Text |
| `openwork_metadata` | OpenWork metadata | Text (JSON) |

Metadata includes the submitted name/email, form mode, source, entrypoint,
OpenWork server and OpenCode versions, OS version, platform, and submission time.
Empty and `unknown` values are omitted. Versions remain text. Adding context to
metadata does not require a new Plain field schema; update the API's allowlisted
context inputs and it will be included in the JSON automatically.

**Configure the schemas before deploying this change.** Plain rejects thread
fields whose keys/types do not match the workspace's schemas. Using Node 22.18+
from `ee/apps/landing`:

1. Preview the definitions with `pnpm plain:setup-fields`. This makes no API calls.
2. Set `PLAIN_SETUP_API_KEY` in your shell to a key with
   `threadFieldSchema:read` and `threadFieldSchema:create`, then run
   `pnpm plain:setup-fields --apply`. Use the same Plain workspace as the form.
   The command adds missing schemas, skips existing keys with matching types,
   and stops if an existing key has a different type. It never edits existing
   schemas and can be rerun after a partial failure.
3. Add `threadField:create` to the landing app's existing `PLAIN_API_KEY`.
   Schema-management permissions are only needed for setup.
4. In Plain's **Settings → Thread fields**, verify the four OpenWork fields.
   They are optional, read-only to support agents, and have AI autofill and
   inclusion in AI agent context disabled. Values are sent in `createThread`;
   no extra API calls are made per submission.

The desktop feedback URL already supplies OS and version information when
available; this change records that submitted context without inferring missing
values. Name/email remain on the customer, with the submitted values preserved in metadata. Existing threads are not backfilled.

App feedback links explicitly identify the client runtime as `web` or `desktop`.
Web feedback uses `web@<build SHA>` as the app version, identifying the UI bundle
independently of the desktop package and connected server. The build SHA comes
from Vite's build environment or local Git checkout; Vercel supplies
`VERCEL_GIT_COMMIT_SHA`, and the Daytona snapshot builder passes `OPENWORK_GIT_SHA`
into Docker. Custom builds can set `VITE_OPENWORK_BUILD_SHA`. Without a build SHA,
web feedback omits the app version. Desktop feedback uses its release version and
omits `0.0.0` development placeholders. Links without a deployment leave it unset.

The forms no longer use Resend, SMTP, or internal feedback recipient overrides.
Without `PLAIN_API_KEY`, submissions return an unavailable response; this also
applies in local development. Use a separate Plain workspace/key for development
if you want to submit real requests. Submission itself creates a thread; configure
any automatic acknowledgement in Plain.

## Deploy (recommended)

This app is ready for Vercel or any Node-compatible Next.js host.

### Vercel

1. Create a new Vercel project rooted at `ee/apps/landing`.
2. Build command: `pnpm --filter @openwork-ee/landing build`
3. Output: `.next`
4. Start command: `pnpm --filter @openwork-ee/landing start`
5. Enable Vercel BotID for the project so protected form routes can reject automated submissions.

### Self-hosted

1. Build: `pnpm --filter @openwork-ee/landing build`
2. Start: `pnpm --filter @openwork-ee/landing start`
