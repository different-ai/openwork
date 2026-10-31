# Computer use in the background

- **Feature key:** `computerUse` (includes background delivery)
- **Deployments:** cloud and self-hosted
- **Author:** reachjalil
- **Default:** follows `computerUse`; there is no separate background rollout.

## What people get

On a Mac, an agent with control of an app window works in that window where
it is. The window is not brought to the front, the person's cursor does not
move and their Space does not change, so they keep working in their own apps.
Several chats can each work in their own window at the same time.

Agents also read the window's accessibility tree first. An observation skips
the screenshot when the tree names at least eight controls to act on, and the
agent asks for an image (`include_image: true`) when it needs coordinates.

Some apps and steps still need the front, and get it the way they did before
(the window comes forward, then is handed back):

- whole sessions in Blender, Unity, Unreal, games, and apps built with Qt,
  wxWidgets or Tk, which read only real pointer input;
- single steps in any app: menu shortcuts (⌘ keys), clicks with modifier
  keys, hover, drags, and typing in Chromium, Electron and Catalyst apps.
  When such a step needs the window brought forward and uses coordinates,
  nothing is sent and the agent is asked to look again.

## How it works

- Desktop reports `computerUse` to the computer broker. New sessions on a
  parallel computer (This Mac) start the helper with background delivery.
  The old `computerSetBackgroundEnabled` IPC remains a no-op for older
  renderers; their cached child-flag value cannot disable background delivery.
  Remove that IPC when those renderers are no longer supported.
- The helper decides per session (`InputDelivery.decide`): background for
  control sessions, foreground for the apps above or when the private calls
  below are missing on that macOS. Background sessions launch apps without
  activating them. Per step, `InputDelivery.stepNeedsFront` picks the steps
  that take the front anyway. The open result carries the session's
  `delivery`; every action receipt carries the step's.
- The agent's frame and cursor are drawn just above the session's window, not
  above every window, so a window the person brings forward covers them. The
  Take over / Stop pill stays on top.
- Background input never raises the window or activates the app, and never
  sends the person's front app anything. Before a click it sends the app one
  WindowServer focus record for the window (`SLPSPostEventRecordTo`); before
  keys it also sends the make-key pair and reads the app's focused window back.
  Pointer events go to the app's process (`SLEventPostToPid` for Chromium,
  Electron and Catalyst apps, `postToPid` for others), with a discarded press
  outside every window first for Chromium's user-gesture check. Hit tests ask
  the app, not the screen, what is under the point.
- Keys are sent only when the app reports the target window as focused and the
  observed field still has focus. If the app never focuses it, nothing is typed
  (`background_keys_unavailable`) and the session's later steps take the front.
- Background steps skip the per-computer turn queue, the focus lock and the
  typing-gap wait. The person's own clicks and typing stop a background step
  only when they are in the agent's app. Steps that take the front use the
  existing shared-desktop path and the cross-process focus lock.
- An app sends keys to its one key window, so sessions in different windows
  of the same app take turns: every control step that can change that window
  (a background focus or make-key record, or bringing a window forward) holds
  the app's cross-process lock until its input is sent. Sessions in different
  apps still work at the same time.

## How to try it

1. Turn on `computerUse` for your organization.
2. Ask an agent to work in TextEdit or Notes while you keep using another app.
3. Run the real-app check with the desktop open:
   `pnpm --filter @openwork/computer-use prove:mac-apps`. Each action receipt
   includes `desktop.front_app_changed`, `desktop.cursor_moved` and
   `desktop.space_changed`; in background sessions all three should stay
   `false` unless the person moved something themselves.

## Turning it off

Turning `computerUse` off (including its kill switch) stops computer use and
hands sessions back, including background sessions. It does not switch them
to foreground delivery. The helper still chooses the foreground when required
by an app or step. Nothing is stored.

## What to watch

- Receipts with `delivery: "background"` and `settled: false` or
  `background_keys_unavailable`: the app ignored background input. Add its
  bundle id to `InputDelivery.foregroundBundlePrefixes`.
- The private SkyLight calls can change with a macOS release. When a symbol is
  missing, sessions fall back to the foreground on their own; check the
  real-app run on each new macOS.
