# OpenWork for iPhone

The OpenWork app for iPhone, written in Swift with SwiftUI. Its first release
does one thing: a member of a workspace that uses Workbot signs in and talks
to Workbot in one conversation.

## What the first release does

- **Sign in with OpenWork** in the system's sign-in sheet, and sign out.
- **One conversation with Workbot:** earlier messages, sending text, the
  answer arriving live, Stop, and Try again when an answer fails.
- **A one-time notice** about how Workbot uses AI providers, agreed to before
  the first message and readable again from Account.
- **Account:** who is signed in, the privacy policy, terms, support, and a way
  to report an answer (touch and hold it).

It leaves out, on purpose: attachments, notifications, side chats, files,
the calendar, background task controls, the computer view, and Apps. Files
and background work that Workbot produces are named in the conversation and
opened on the web.

## What it asks of the phone

Nothing that shows a permission prompt: no camera, photos, microphone,
location, contacts, notifications, or tracking. It makes HTTPS requests to
the Workbot server and stores its session in the Keychain. It has no
third-party code, no purchases, and no links to buy anything.

Its one capability is Associated Domains, so iOS returns sign-in to this app
and no other (see below).

## How sign-in works

The phone never holds an OpenWork token. It holds a session only the Workbot
server can read, and that session opens nothing but Workbot.

1. The app makes a PKCE pair and opens `/auth/app/login` on the Workbot server
   in the system's sign-in sheet.
2. OpenWork signs the person in and returns to Workbot, which sends the code
   to `/auth/app/callback` on its own address. iOS opens that address only in
   this app, because the server lists the app's ID in
   `/.well-known/apple-app-site-association`.
3. The app trades the code and its verifier at `POST /auth/app/token` for its
   session, and sends it as `Authorization: Bearer` on every request.

This needs three things to line up: the server runs on HTTPS with
`WORKBOT_IOS_TEAM_ID` set, the app is signed by that team, and the workspace
has the `workbotMobile` feature on. Server side:
[Workbot's README](../workbot/README.md#the-phone-app).

## Layout

| Path | What it is |
|---|---|
| `OpenWork/` | The app: screens, wording, design values, assets. New files here join the build on their own. |
| `OpenWorkKit/` | Everything that is not a screen: sign-in, the session, the Workbot API, live answers, and the models the screens read. A Swift package with its own tests. |
| `Config/` | `Info.plist` for store builds, `Info-Debug.plist` for development builds, and the entitlements. |
| `Tools/stand-in-server.mjs` | A stand-in Workbot server for the simulator. |

## Build and test

Needs Xcode 26 or later. All commands run from this folder.

```bash
# Logic tests: no simulator needed
swift test --package-path OpenWorkKit

# Build for a simulator
xcodebuild -project OpenWork.xcodeproj -scheme OpenWork -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

Formatting and lint: `swiftformat .` and `swiftlint` use the settings in this
folder.

## Run it against the stand-in server

A development build cannot finish a real sign-in: it has its own app ID
(`com.differentai.openwork.dev`), and the server returns sign-in only to the
store app. To see the screens, start the stand-in server and launch the
development build already signed in to it:

```bash
node Tools/stand-in-server.mjs
xcrun simctl launch booted com.differentai.openwork.dev \
  -OpenWorkServerURL http://127.0.0.1:8787 \
  -OpenWorkDevelopmentSession dev-session
```

Add `-OpenWorkDevelopmentConsent YES` to skip the AI notice. Start the server
with `--phones-off` or `--workbot-off` to see the locked screens. The messages
`fail`, `limit`, and `slow` show a failed answer, a used-up free allowance,
and a long answer to stop. These launch arguments exist only in development
builds.

## Build for the App Store

1. In Xcode, select the OpenWork target, then Signing & Capabilities, and
   choose the Apple developer team that signs the desktop app. The app ID
   `com.differentai.openwork` and Associated Domains for the Workbot server
   are already set.
2. Product, then Archive. The scheme archives the Release configuration,
   which talks to `https://chat.openworklabs.com`.
3. Distribute from the Organizer.

From the command line, with the team's ID:

```bash
xcodebuild -project OpenWork.xcodeproj -scheme OpenWork -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/OpenWork.xcarchive \
  DEVELOPMENT_TEAM=<team id> -allowProvisioningUpdates archive
```

Before a submission can pass review, the server has to be ready too: the
phone sign-in deployed with `WORKBOT_IOS_TEAM_ID`, `workbotMobile` on for the
workspace Apple's reviewer signs in to, and a demo account for that workspace
in the review notes. In App Store Connect, keep the app unavailable on Mac:
the desktop app already uses this app ID there.

## What is not built yet

Android, an iPad layout, dark mode, and everything listed under "leaves out"
above.
