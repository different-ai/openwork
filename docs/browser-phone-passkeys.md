# Passkeys from a phone in the built-in browser

Feature: `browserPhonePasskeys` (cloud and self-hosted, off). This page records
what the desktop app's browser engine can and can't do, what OpenWork ships
behind the flag, and the Electron change the feature needs.

The goal is Chrome's "Use a phone or tablet" option: WebAuthn hybrid transport
(caBLE v2). The page asks for a passkey, the person scans a QR code with a
phone that holds the passkey, the phone connects through a tunnel server and
proves it is nearby over Bluetooth Low Energy, the person approves on the phone,
and the assertion goes back to the page that asked. This is not Touch ID
(`app.configureWebAuthn({ touchID })`, credentials bound to this Mac), not
Apple platform passkeys (`platformPasskeys`, Electron 45, limited to the app's
own associated domains), and not Google Password Manager sync.

## Feasibility (checked 2026-10-20)

| Electron | Chromium | Hybrid API for apps |
| --- | --- | --- |
| 43.7.7 (our lock) | 150.0.7871.250 | None |
| 43.8.2, 44.9.2 (latest) | | None (checked `electron.d.ts`) |
| 45.0.0-beta.6 | | None. Adds `platformPasskeys` (Apple sheet, associated domains only) and `select-webauthn-authenticator` |
| electron/electron#53733 | 155 | Draft PR, open, never built or run in CI |

Why there is no QR code in stock Electron: Chromium adds `kHybrid` to every
request but creates the hybrid discovery only when the embedder calls
`FidoDiscoveryFactory::set_cable_data()` with a QR generator key from
`AuthenticatorRequestClientDelegate::ConfigureDiscoveries()`. The base class
version does nothing (`content/public/browser/authenticator_request_client_delegate.cc`),
and Chrome's version (`chrome/browser/webauthn/chrome_authenticator_request_delegate.cc`)
generates the key, encodes it with `device::cablev2::qr::Encode()` and shows the
QR in Chrome's own dialog. Electron's `ElectronAuthenticatorRequestClientDelegate`
in v43.7.7 does not override `ConfigureDiscoveries`, ignores the Bluetooth
callbacks passed to `RegisterActionCallbacks`, and has no cable event hook.
`app.configureWebAuthn` and `select-webauthn-account` don't reach this path.

What it looks like from the page, measured on Electron 43.7.7, macOS, with
`apps/desktop/scripts/webauthn-hybrid-probe.mjs` (result in
`docs/browser-phone-passkeys/probe-electron-43.7.7.json`):

- `PublicKeyCredential.getClientCapabilities()` reports `hybridTransport: true`
  (Chromium only checks that a Bluetooth LE adapter exists), so sites offer
  "use your phone".
- A `get()` that only a phone could serve shows nothing, fires no session
  event, and fails with `NotAllowedError` once the timeout runs out. Chromium
  makes that timeout at least 3 minutes (`kMinRequestTimeout`): 180,006 ms when
  the page asked for 6 s, 200,005 ms when it asked for 200 s.
- With OpenWork's listeners attached (feature on), nothing changes: no event,
  same failure. OpenWork never shows a QR code on stock Electron.

Scope of that result: macOS (measured) and Linux (same code path). On
Windows 11, Chromium hands WebAuthn to the Windows WebAuthn API, and when that
API supports hybrid, Chromium doesn't start its own (`device/fido/fido_discovery_factory.cc`,
"Windows handles it"). So the embedded browser probably already gets the
Windows dialog with its phone option there. Not tested yet.

## Standard ways to do this, compared (2026-10-20)

| Path | Who owns the phone QR and checks | What it needs | Fit |
| --- | --- | --- | --- |
| 1. Embedded Electron + hybrid events (this PR) | Chromium | Electron to merge #53733 or similar (draft, never built) | Keeps the built-in browser. Blocked upstream |
| 2. Apple browser passkey API | macOS (Apple's sheet can offer a phone; Chromium turns that off with `shouldShowHybridTransport = false` in `device/fido/mac/icloud_keychain_sys.mm`) | Apple-approved `com.apple.developer.web-browser.public-key-credential`, available only to apps that act as a web browser: http/https handler, a URL field or search on launch. Plus a provisioning profile and an Electron change (`set_nswindow`) | macOS only. A product decision to be a Mac browser |
| 3. `ASWebAuthenticationSession` | The default browser | Our own sign-in only | Doesn't sign the built-in browser in to other sites. Our own sign-in already uses the system browser and an `openwork://` link, the RFC 8252 pattern |
| 4. Installed Chrome or Edge with a dedicated OpenWork profile | Chrome (full phone, Bluetooth and passkey UI) | Chrome installed. The whole site session lives in that profile, driven through the same conversation-owned browser tools over `--remote-debugging-pipe` (Chrome 136+ requires a non-default `--user-data-dir`) | Most standard for arbitrary sites today. A different browser surface, not the embedded panel |
| 5. Windows 11 WebAuthn API | Windows | Nothing, if the check above holds | Windows only |

Rejected: drawing our own QR and running caBLE v2 in Node (custom
cryptography and a page shim); forwarding a site's WebAuthn request from the
built-in browser to another browser (`chrome.webAuthenticationProxy` is for
remote desktop, and overriding the origin breaks phishing resistance); copying
cookies from Chrome into the built-in browser.

## What ships behind the flag

- `packages/features/src/registry.ts`: `browserPhonePasskeys`, off.
- `apps/desktop/electron/browser-phone-passkeys.mjs`: listens for the
  hybrid events on the built-in browser session only while the feature is on.
  Electron arms hybrid only when a listener accepts the request, so a disabled
  feature means WebAuthn behaves exactly as before. Each request:
  - is accepted only when Chromium's payload matches `FIDO:/<digits>`, the
    frame is a live frame of a built-in browser tab, and its origin is https
    or loopback http. Nothing else gets a QR code.
  - shows its code only while its tab is on screen in the conversation that
    owns it. In a background tab it waits, and the code appears when the
    person opens that tab. Handing the tab to another conversation, closing
    the tab, or turning the feature off cancels the request.
  - one code per tab. A new request in the same tab cancels and replaces the
    old one.
  - the QR payload goes only to the sheet. Nothing is sent to the app's
    renderer, browser tools or agents.
- `apps/desktop/electron/phone-passkey-sheet.mjs`: a modal sheet over the
  window. The window is sandboxed, has JavaScript disabled, uses an in-memory
  partition, has no preload, and has a `default-src 'none'` CSP. It shows the
  relying party, who asked (when the page isn't on the relying party's domain),
  the QR code and one state line ("Scan with your phone's camera", "Phone
  connected", "Continue on your phone", "Bluetooth is off", "OpenWork can't use
  Bluetooth"). Cancel and esc call the request's `cancel()` when Electron
  provides it. Otherwise the sheet closes and the page's own timeout ends the
  request.
- `apps/desktop/electron-builder.base.yml`: `NSBluetoothAlwaysUsageDescription`,
  required by macOS before an app may use Bluetooth.
- `apps/app`: the session page sends the flag to the desktop host
  (`browser.setPhonePasskeysEnabled`).

OpenWork never generates or stores a QR secret or phone key, never approves
anything (approval happens on the phone), and doesn't touch origin or relying
party checks. Chromium does all of that.

Kill switch: turning the feature off removes the listeners and cancels open
requests. Nothing is stored.

## The Electron change it needs

`docs/browser-phone-passkeys/electron-v43.7.7-webauthn-hybrid.patch` applies
cleanly to Electron v43.7.7 (`git apply --check`). It has not been compiled:
building Electron needs a Chromium checkout and more than 100 GB of disk.
The symbols it uses were checked against Chromium 150.0.7871.250. The patch is
#53733 adapted to Chromium 150 (`ConfigureDiscoveries` has no
`cmtg_key_requested` there), plus what an embedded browser needs:

1. `ConfigureDiscoveries` override. Only for modal WebAuthn requests with
   Bluetooth LE available (not on Windows 11, which shows its own QR code). It
   generates a fresh QR key per request with `crypto::RandBytes`, encodes it
   with `device::cablev2::qr::Encode`, and emits `webauthn-hybrid-request`
   `{ requestId, relyingPartyId, requestType, qrCode, frame, cancel }`.
2. Opt-in with `event.preventDefault()`, like `select-bluetooth-device`. Only
   then does it call `set_cable_data` and `set_network_context_factory` (the
   requesting session's storage partition, so proxy and certificate settings
   match). #53733 arms hybrid for any listener, so an app couldn't decline a
   request it didn't recognise.
3. `cancel()` on the details posts `CancelRequest()`, so the page gets
   `NotAllowedError` right away (#53733 has no app-driven cancel).
4. `set_cable_event_callback` turns `kPhoneConnected`, `kBLEAdvertReceived` and
   `kReady` into `webauthn-hybrid-request-updated` states (#53733 lists this
   as a follow-up).
5. Bluetooth: keeps `request_ble_permission_callback` and requests permission
   on `kPendingPermissionRequest`. It reports `bluetooth-off` and
   `bluetooth-permission-denied` as states. It never powers the adapter on by
   itself.
6. `webauthn-hybrid-request-completed` `{ requestId, relyingPartyId, frame }`,
   posted from the delegate destructor.
7. Docs in `docs/api/session.md` and specs in `spec/api-web-authn.spec.ts`.

Upstream path: offer points 2 to 4 on #53733 (or a follow-up PR), then
backport to the supported release lines. OpenWork can carry the patch only by
shipping its own Electron build (for example through `electron/build-tools`
and `ELECTRON_OVERRIDE_DIST_PATH` in development), which we don't do today.

## Checking it

Automated, no phone: `node --test apps/desktop/test/browser-phone-passkeys.test.mjs`
covers gating, payload and origin checks, tab and owner binding, cancel,
replacement and the sheet markup, using a fake session shaped like the
upstream events. `pnpm --filter @openwork/desktop exec electron ./test/phone-passkey-sheet.electron.mjs`
opens the real sheet window, hidden, with a placeholder payload, and checks
that script, Node and preload are off, and that Cancel, esc and closing the
window cancel. None of these prove the phone or Bluetooth transport. Virtual
authenticators can't prove it either.

Real phone, once an Electron build with the patch exists:

1. Run `pnpm --filter @openwork/desktop exec electron ./scripts/webauthn-hybrid-probe.mjs`
   with that build. `hybridEventsAvailable: true` means Chromium's payload arrived.
2. Launch OpenWork from Finder (macOS attributes Bluetooth use to the launching
   terminal otherwise), turn on `browserPhonePasskeys` for a test organization,
   and open a site that has a passkey on a test phone.
3. A person scans the code with the phone, keeps it nearby, and approves on
   the phone. Check that the tab is signed in, that Cancel ends the request
   with an error on the page, that a background conversation's request waits
   for its tab, and what happens with Bluetooth off and with permission denied.
