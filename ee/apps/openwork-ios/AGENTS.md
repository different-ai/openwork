# OpenWork for iPhone: notes for agents

The repository's root `AGENTS.md` applies. This file adds only what the code
here cannot tell you. Read `README.md` for what the app does and how to run it.

## Facts

- App ID `com.differentai.openwork.ios` (store) and `com.differentai.openwork.dev`
  (development). iPhone only, iOS 26 and later, portrait. It follows the
  system's light and dark appearance and text size.
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

## Keep it native

- Build screens from system components: `NavigationStack` titles and
  toolbars, `Form`, `ContentUnavailableView`, `confirmationDialog`, system
  button styles. Do not draw your own bars, sheets, or buttons.
- Use system colors and styles (`.primary`, `.secondary`, `.fill.tertiary`,
  `.tint`). The only custom color is `AccentColor`. No fixed hex colors and
  no forced appearance.
- Glass belongs to the control layer only: the system's bars, and the message
  field and its button (`safeAreaBar`, `GlassEffectContainer`, `glassEffect`,
  `.glassProminent`). Never put glass behind conversation content, and never
  stack glass on glass.
- Text uses system text styles so it scales. Check a change at an
  accessibility text size and in dark appearance before calling it done.

## Use current APIs

Models still reach for older ones. Here: `@Observable` (not
`ObservableObject`), `NavigationStack`, `.task`, `foregroundStyle`,
`clipShape(.rect(cornerRadius:))`, `ScrollPosition`, format styles, Swift
Testing, and `async`/`await` with no Grand Central Dispatch. When unsure of an
API, check Apple's documentation rather than memory.
