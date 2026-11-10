# Remote desktop device sign-in (TASK-387)

- **Flag:** `remoteDesktopDeviceLogin`
- **Deployments:** cloud and self-hosted; **default off**
- **Owner:** [yomgui](https://github.com/yomgui)
- **Client ID:** `openwork-desktop-device`

A running remote desktop can request its own Den session without receiving a
browser session, a CLI credential file, or a pasted sign-in link. It reuses Den's
existing device authorization and explicit `/device` review page.

![Desktop device approval on a private test server, with a required organization and explicit consent.](./approval.png)

Real Den approval page with an isolated synthetic account; the displayed user
code is public and expired. This image illustrates the UI, not native-install
verification.

## Enable and try

Use a Den API, Den web and desktop from the release shipping this feature. Enable
**Remote desktop device sign-in** for **everyone** on the deployment's `/admin`
Features page. An organization-only override cannot enable anonymous code starts.
A self-host operator may instead set the generated Helm value
`config.features.remoteDesktopDeviceLogin: true`
(`DEN_FEATURE_REMOTE_DESKTOP_DEVICE_LOGIN=true`). Kill switches take precedence.
Decision and redemption also require the approving member/organization's flag.

On the remote computer, start/activate the OpenWork desktop. The desktop bundles
its server CLI, but does **not** install `openwork-server` on PATH. Use the bundled
Electron executable in Node mode for this command only (not for the running app).
No separate Node installation or launcher is required.

### macOS: installed public app

For the normal `/Applications/OpenWork.app` installation:

```sh
ELECTRON_RUN_AS_NODE=1 \
  "/Applications/OpenWork.app/Contents/MacOS/OpenWork" \
  "/Applications/OpenWork.app/Contents/Resources/app.asar/server/dist/cli.js" \
  device-login
```

If you installed it elsewhere, change `/Applications` accordingly. For the Cloud
or Enterprise flavor, substitute **both** the bundle and executable names:

| Flavor | Bundle | Executable inside `Contents/MacOS/` |
| --- | --- | --- |
| Public | `OpenWork.app` | `OpenWork` |
| Cloud | `OpenWork Cloud.app` | `OpenWork Cloud` |
| Enterprise | `OpenWork Enterprise.app` | `OpenWork Enterprise` |

The CLI remains `Contents/Resources/app.asar/server/dist/cli.js` in each flavor.

### Linux: extracted installation

For an installation extracted to `$HOME/Applications/OpenWork`:

```sh
APP="$HOME/Applications/OpenWork"
ELECTRON_RUN_AS_NODE=1 "$APP/openwork" \
  "$APP/resources/app.asar/server/dist/cli.js" device-login
```

Set `APP` to your actual extracted directory. The Cloud executable is
`openwork-cloud`; Enterprise is `openwork-enterprise`. The relative CLI path is
the same. For an AppImage, extract it with `./OpenWork.AppImage --appimage-extract`
(using the actual downloaded filename), then use `APP="$PWD/squashfs-root"` and
the same command; do not guess its temporary mount path.

Append `--force` to deliberately replace an existing desktop sign-in. Append
`--base-url https://den.example.test --api-base-url https://api.example.test`
when selecting an explicit Den destination. If you separately installed the npm
server CLI, the equivalent entry point is `openwork-server device-login`.

Open the printed verification URL on the other computer. Sign in, compare the
code, select the organization and approve only if you started the request.
An organization is required. The remote desktop adopts that explicit selection,
without its usual in-app organization chooser, and the existing runner bridge
handles machine registration. The final line reports the account and organization;
`Runner: unknown` means runner state is not exposed to this control action, not
that registration succeeded.

The shell uses the desktop's existing authenticated `127.0.0.1` control bridge.
The desktop must be running; a server-only process without a desktop renderer
cannot enroll itself. `OPENWORK_UI_CONTROL_DISCOVERY` can select one explicit
profile's discovery file; otherwise the production profile is used, never an
implicit development-profile fallback. The command checks POSIX ownership and
permissions, refuses symlinks/untrusted directories/non-loopback destinations,
and never prints raw bridge receipts. POSIX discovery files are written with mode `0600`, including when replacing an
older permissive file. The shell command intentionally fails closed on Windows
with “Use the sign-in link instead.” POSIX-only shell support is accepted for
TASK-387; verifying owner-only Windows ACLs is a separate follow-up. No named
pipe or Windows custody implementation is included.

Only the user code, verification link, public status and final account/org cross
the shell boundary. The private device code and Den bearer remain in the app's
existing authentication/enrollment path. The local control bridge credential is
separate from a Den session. No tokens belong in command arguments or URLs.

Packaged `file://` renderers use the app's existing Electron main-process Den
HTTP transport, just like link handoff. This is internal app transport—not a
new shell IPC path—and does not relax Den CORS or trust `Origin: null`.
Device code/token requests refuse redirects and retain cancellation/deadlines.
Private request bodies and credentials are never exposed to control callers,
engine configuration or plugins.

## Turn it off

Use **Turn off everywhere** in Features for the immediate server kill switch.
New desktop starts are rejected, pending desktop decisions and redemptions cannot
issue a session, and polling terminates with unsupported/failed. Codes are not
restarted under `openwork-cli`. Approval metadata is captured only from the
successful atomic claim and kept in request-scoped state, cleared in `finally`.
The session insert then rechecks membership and rollout policy under lock. If a
later guard refuses issuance, the one-time code has already been consumed: the
person must restart the command. It is never reused or rebound to a default org.
Existing completed sessions are not revoked by a rollout change. Explicit sign-out/revocation remains separate.

Existing CLI/plugin device sign-in, desktop sign-in links and
`auth.exchange-grant` are never gated by this flag and retain their behavior.
Older Den reports unsupported: **use the sign-in link instead**.

Exit codes: success `0`, failure `1`, denied `2`, expired `3`, unavailable `4`,
interrupted/cancelled `130`. Interrupting stops the local poll; it does not revoke
an unredeemed server-side authorization, which expires normally.

## Shared enrollment and regression coverage

`apps/app/src/app/lib/den-handoff.ts` extracts the existing durable commit into
one shared enrollment function: bootstrap persistence/read-back, serialized
activation, supersession and rollback are reused rather than copied. Existing
link handoffs and `auth.exchange-grant` retain their organization-choice behavior
and are not gated. Only this new device path supplies an explicit browser-approved
organization.

`ee/apps/den-api/test/api/sso-callback.api.test.ts` extends the existing real-SSO
fixture to cover the new client: a password session cannot approve an SSO-required
organization, and a fresh device session inherits the approving session's actual
provider and original authentication time. It does not change SSO policy.

## Watch and limits

Watch code-start/decision/redemption failures, desktop enrollment failures and
existing runner registration health. Never log request bodies, device codes or
bearers. An approved organization is the initial active org, **not an org-locked
credential**. This is a new general Den session, not OAuth access/refresh tokens,
DPoP, VM attestation or an independently named/revocable device.

Follow-ups remain separate: OAuth device authorization, DPoP-bound audience/org
claims, rotating refresh tokens with reuse detection, Devices/revoke UI, and the
Better Auth security upgrade. No schema migration is part of this feature.
