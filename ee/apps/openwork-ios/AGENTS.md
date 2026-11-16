# OpenWork for iPhone: notes for agents

The repository's root `AGENTS.md` applies. This file adds only what the code
here cannot tell you. Read `README.md` for what the app does and how to run it.

## Facts

- App ID `com.differentai.openwork` (store) and `com.differentai.openwork.dev`
  (development). iPhone only, iOS 26 and later, portrait, light appearance.
- Swift 6 language mode with strict concurrency. The app target isolates to
  the main actor by default; `OpenWorkKit` does not.
- No third-party dependencies. Adding one is a decision to raise first.

## Commands

Run from `ee/apps/openwork-ios`. Name the scheme and destination every time.

```bash
swift test --package-path OpenWorkKit
xcodebuild -project OpenWork.xcodeproj -scheme OpenWork -configuration Debug -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

Send build output to a file and read only the failing part. To see a change
on screen, follow "Run it against the stand-in server" in `README.md`.

## Where things go

- A screen or anything drawn: `OpenWork/`. Files added there build without a
  project edit.
- Anything else (requests, models, parsing, state): `OpenWorkKit/`, with a
  test beside it. Logic stays out of views so it can be tested without a
  simulator.
- Wording people read: `OpenWork/Theme.swift` (`Wording`) or the view itself,
  as localizable strings. Copy matches the Workbot web page where it has the
  same message.
- Every control a person can tap has an `accessibilityIdentifier`.

## Do not change without being asked

- `OpenWork.xcodeproj/project.pbxproj`, signing, the entitlements, the app
  IDs, and the lowest iOS version.
- The first release's limits: nothing that shows a permission prompt, no
  purchases or links to buy, no web views, no notifications. Each exists to
  keep App Review simple.
- The sign-in contract. It is shared with the Workbot server
  (`ee/apps/workbot/src/server/auth.ts`) and tested on both sides.

## Use current APIs

Models still reach for older ones. Here: `@Observable` (not
`ObservableObject`), `NavigationStack`, `.task`, `foregroundStyle`,
`clipShape(.rect(cornerRadius:))`, `ScrollPosition`, format styles, Swift
Testing, and `async`/`await` with no Grand Central Dispatch. When unsure of an
API, check Apple's documentation rather than memory.
