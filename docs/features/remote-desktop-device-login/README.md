# Remote desktop device sign-in (TASK-387)

- **Flag:** `remoteDesktopDeviceLogin`
- **Deployments:** cloud and self-hosted; **default off**
- **Owner:** [yomgui](https://github.com/yomgui)
- **Client ID:** `openwork-desktop-device`

A running remote desktop can request its own Den session without receiving a
browser session, a CLI credential file, or a pasted sign-in link. It reuses Den's
existing device authorization and explicit `/device` review page.

## Enable and try

Use a Den API, Den web and desktop from the release shipping this feature. Enable
**Remote desktop device sign-in** for **everyone** on the deployment's `/admin`
Features page. An organization-only override cannot enable anonymous code starts.
A self-host operator may instead set the generated Helm value
`config.features.remoteDesktopDeviceLogin: true`
(`DEN_FEATURE_REMOTE_DESKTOP_DEVICE_LOGIN=true`). Kill switches take precedence.
Decision and redemption also require the approving member/organization's flag.

On the remote computer, start/activate the OpenWork desktop, then run:

```sh
openwork-server device-login
# To deliberately replace an existing desktop sign-in:
openwork-server device-login --force
# Optional explicit Den destination:
openwork-server device-login --base-url https://den.example.test --api-base-url https://api.example.test
```

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
and never prints raw bridge receipts. Its custody check currently fails closed
on Windows rather than assuming POSIX modes establish Windows ACL protection.
Use the sign-in link on Windows.

Only the user code, verification link, public status and final account/org cross
the shell boundary. The private device code and Den bearer remain in the app's
existing authentication/enrollment path. The local control bridge credential is
separate from a Den session. No tokens belong in command arguments or URLs.

## Turn it off

Use **Turn off everywhere** in Features for the immediate server kill switch.
New desktop starts are rejected, pending desktop decisions and redemptions cannot
issue a session, and polling terminates with unsupported/failed. Codes are not
restarted under `openwork-cli`. Existing completed sessions are not revoked by a
rollout change. Explicit sign-out/revocation remains separate.

Existing CLI/plugin device sign-in, desktop sign-in links and
`auth.exchange-grant` are never gated by this flag and retain their behavior.
Older Den reports unsupported: **use the sign-in link instead**.

Exit codes: success `0`, failure `1`, denied `2`, expired `3`, unavailable `4`,
interrupted/cancelled `130`. Interrupting stops the local poll; it does not revoke
an unredeemed server-side authorization, which expires normally.

## Watch and limits

Watch code-start/decision/redemption failures, desktop enrollment failures and
existing runner registration health. Never log request bodies, device codes or
bearers. An approved organization is the initial active org, **not an org-locked
credential**. This is a new general Den session, not OAuth access/refresh tokens,
DPoP, VM attestation or an independently named/revocable device.

Follow-ups remain separate: OAuth device authorization, DPoP-bound audience/org
claims, rotating refresh tokens with reuse detection, Devices/revoke UI, and the
Better Auth security upgrade. No schema migration is part of this feature.
