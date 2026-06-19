---
name: daytona-chrome-cdp
description: Launch and control standalone Chrome in a Daytona sandbox via CDP. Use for web sign-in, OAuth, Den Web setup, browser-only flows, or when the app should not be driven through Electron CDP.
---

# Daytona Standalone Chrome CDP

Use this skill when a Daytona sandbox needs a normal Chrome/Chromium browser in
the XFCE display, separate from the Electron app. This is useful for Den Web
sign-in, OAuth provider setup, browser-only admin flows, and checking what a user
would see in a regular browser.

## Launch Chrome

Run inside the Electron or server sandbox:

```bash
daytona exec "$SANDBOX" -- "bash -lc 'mkdir -p /tmp/daytona-chrome-profile; DISPLAY=:99 nohup chromium --no-sandbox --disable-dev-shm-usage --remote-debugging-address=0.0.0.0 --remote-debugging-port=9222 --user-data-dir=/tmp/daytona-chrome-profile about:blank >/tmp/daytona-chrome.log 2>&1 &'"
```

If `chromium` is missing, try `google-chrome`, `google-chrome-stable`, or install
Chromium in the sandbox only when needed.

## Get The CDP URL

```bash
CHROME_CDP_URL=$(daytona preview-url "$SANDBOX" -p 9222 2>/dev/null | grep -v '^time=')
```

Then connect browser tools:

```text
browser_list({ browser_url: CHROME_CDP_URL })
```

## Verify It Is Not Electron

After selecting the Chrome target:

```js
navigator.userAgent
```

Expected: contains `Chrome/` or `Chromium/` and does not contain `Electron/`.

## Drive A Web Flow

Use normal browser tools:

```text
browser_navigate({ browser_url: CHROME_CDP_URL, target_id: TARGET_ID, url: DEN_WEB_URL })
browser_snapshot({ browser_url: CHROME_CDP_URL, target_id: TARGET_ID })
browser_click({ browser_url: CHROME_CDP_URL, target_id: TARGET_ID, uid: UID })
browser_fill({ browser_url: CHROME_CDP_URL, target_id: TARGET_ID, uid: UID, value: VALUE })
```

Validate with the `daytona-flow-validator` loop. Do not assume navigation or
sign-in worked until the post-action snapshot or URL proves it.

## Common Uses

- Sign into Den Web while Electron remains on the desktop handoff screen.
- Complete OAuth approval pages from a mock or real provider.
- Configure web-only admin state before validating Electron sync.
- Compare Den Web behavior against Electron cloud account behavior.

## Stop Chrome

```bash
daytona exec "$SANDBOX" -- "bash -lc 'pkill -f \"chromium.*remote-debugging-port=9222\" || pkill -f \"chrome.*remote-debugging-port=9222\" || true'"
```
