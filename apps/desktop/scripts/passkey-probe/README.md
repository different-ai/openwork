# Browser passkey prerequisite probe

This diagnostic app uses the registered `com.openworklabs.com` identifier. It
checks native API availability and the process's browser entitlement, then
reports the existing macOS authorization state if entitled. It never requests
consent, reads or creates a credential, contacts a relying party, or claims a
successful passkey sign-in. It is not the OpenWork browser implementation.

On a Mac with Xcode Command Line Tools:

```sh
node apps/desktop/scripts/passkey-probe/build.mjs
```

Every invocation creates a fresh app in a temporary directory, signs it ad hoc,
validates its signature, and launches its actual executable. The baseline
should report `nativeBrowserApiAvailable: true`, `browserEntitlement: false`,
and `authorizationState: "missing-entitlement"`.

For a real certificate, set `OPENWORK_PROBE_SIGNING_IDENTITY` to a local signing
identity. The script uses it without exporting a private key. Nothing is
installed in Applications or registered as the default browser, and the probe
does not open OpenWork's data directories.

After Apple approves `com.apple.developer.web-browser.public-key-credential`,
enable it for the App ID and download a matching macOS provisioning profile.
Use an appropriate development profile for local testing or a Developer ID
profile for distribution, and the certificate authorized by that profile:

```sh
export OPENWORK_PROBE_SIGNING_IDENTITY='Developer ID Application: YOUR ORGANIZATION (TEAMID)'
export OPENWORK_PROBE_PROVISIONING_PROFILE='/absolute/path/to/profile.provisionprofile'
node apps/desktop/scripts/passkey-probe/build.mjs --browser-permission
```

The profile guard must pass before the executable is launched. A successful
probe with `not-determined` means user authorization is still pending. Even
`authorized` is not an end-to-end WebAuthn test.

## Integration still required

- Electron 43.2.0 exposes the device-bound `touchID` authenticator only.
- Electron's newer `platformPasskeys` path is for domain-associated apps. It
  constructs client data for the relying-party domain and does not implement
  the browser entitlement path for arbitrary website origins.
- The browser integration must preserve Chromium's verified origin and
  relying-party checks and use Apple's browser-specific client-data API. A
  production integration must cover cancellation, conditional requests,
  cross-origin frame rules, and native consent. Adding an entitlement alone
  does not implement this.
- Validate both registration and assertion against a server, including an
  existing credential created in Safari, before any shipping-ID migration.
- Daytona currently directs macOS users to `use.computer`, which needs its
  own account/API access and reserved Mac. A Linux Daytona sandbox cannot
  validate macOS signing or Apple Passwords.

References: [Apple browser entitlement](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.web-browser.public-key-credential),
[Apple browser authentication](https://developer.apple.com/documentation/authenticationservices/authenticating-people-by-using-passkeys-in-browser-apps),
[Electron system passkeys](https://github.com/electron/electron/pull/51563),
[Daytona macOS](https://www.daytona.io/docs/sandboxes#macos-sandboxes).
