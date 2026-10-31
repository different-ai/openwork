# Workbot's Computer tab

Workbot's **Computer** tab appears after **Documents** when `workbot` and
`remoteComputers` are enabled for the organization in `/admin`, together with at
least one of its two views. It opens directly, without a consent screen. The
combined testing branch also includes Documents; its `workbotDocuments` rollout
remains independent.

Each view is its own rollout (both on `cloud` and `self_hosted`, owned by
`reachjalil`):

| Flag | What Workbot gets | Off |
|---|---|---|
| `browserUse` (default off) | The **Browser** view and the `desktop` tool's browser operations. It includes the page stream; teaching browser tasks (`browserDemonstrations`) needs it too. | No Browser view; the model is offered only the native desktop, and the runner refuses browser calls. |
| `computerUse` | The **Computer** view and the `desktop` tool's native-app operations (`computer_*`). | No Computer view; the model is offered only the browser, and the runner refuses native-app calls. |

Workspaces that had Workbot's computer before the split keep the Computer view
and get the Browser view once `browserUse` is turned on for them. Workbot tells
the runner each chat's views (`desktopViews` on the session), taken from Den's
answer at that moment rather than a cached session. A runner from before the
split can't limit the views, so a chat allowed only one gets no desktop there
until the runner is updated; a chat allowed both keeps both.
Turning a flag off applies to the next viewer connection and the chat's next
turn; a viewer already open can outlive it as described under Transport and
rollout. `bash` and `look` are not views: every Workbot chat keeps them while
the runner has a computer.

The two views use one conversation computer:

- **Browser** (`/browser`) streams the page itself with Workbot's tabs and
  address bar. It is included in `browserUse`, without a separate live-view
  gate. Computers whose image predates page streaming still fall back to
  noVNC; remove that transport fallback when those images are unsupported.
  Den and Workbot keep the `browserLiveView` response field derived from
  browser access for older clients; remove it when those clients are unsupported.
- **Computer** (`/computer`) streams the entire Linux desktop.
- **Take control** interrupts Workbot's current turn, pauses both browser and
  computer tools, and enables input through the page stream (Browser) or
  noVNC (Computer and older browser images).
- **Return to Workbot** ends the manual connection and releases the tools.
- **Pause** suspends the VM; reopening the tab leaves it paused until **Resume**.
  Memory, browser tabs and unsaved applications survive VM pause/resume.
- **Rebuild computer** appears when the computer won't connect. After the person
  confirms, Workbot stops the current turn and the runner deletes the VM and
  creates a fresh one from the configured snapshot. The VM's disk, open apps and
  browser tabs are erased; the chat and its kept Files stay. This is also how a
  person moves an existing computer onto a rebuilt snapshot.

Workbot uses its computer in two modes, and the conversation shows each its own way:

- **In the background**: shell commands and file reads (`bash`, `look`), such as
  a command-line Blender render or building a web app. The card reads "Working
  on my computer" with Workbot's own progress notes and never connects a live
  view, so the desktop does not start for this work.
- **On screen**: the `desktop` tool, in the browser or a native app. The card
  shows Workbot's progress notes, and the reply offers **Open Computer**. The
  card shows a live view only when Workbot passes `show: true` because the
  person should watch: they asked to see it, or there is something to look at
  or decide together. A browser lookup the person only wants the result of
  stays a card. The live view appears once it has a picture, never as a
  connecting placeholder.

A reply shows one card for each kind of work, however often Workbot stops to
say what it is doing. While it works on screen, the screen card stays below its
latest words, also while it says what it is doing, so a live view keeps one
connection. Once it turns to work in the background, the screen card goes back
to where it was used, without its live view, until Workbot is on the screen
again. `show` holds for the rest of the reply until Workbot passes `false`.

Workbot is told to work like a coworker and read what the person wants. Most of
the time that is the result, so it works in the background and comes back with
it. It uses the screen only when that helps: the work needs it (a live website,
an app with no command line), the person asks to see it, or there is something
to look at or decide together, and shows it only for the last two. Then it
changes the open app where the person can see each change, and leaves the
screen when that part is done. On longer work it mentions milestones and offers
an early look when that helps the person steer.

While it works, the live card offers the other mode in one tap: **Show me**
when nothing is shown, **Carry on without me** while it shows its screen.
Either sends a follow-up, which Workbot takes up after its current step. Work
the person wants to watch stays in the conversation rather than a background
task, which works out of sight.

The main Workbot conversation's existing `hc-…` computer owns both views. The
viewer does not create a second computer or accept a sandbox/session id from the
page. Agent browser and computer operations use the shared computer-use package,
with the existing `bash` and `look` tools available on the same machine.

## Prepare the headless runner

Build `ee/packages/headless-computer/Dockerfile.desktop` using its digest-pinned
`node:24.22.1-bookworm-slim` default (or an explicitly verified pinned override),
push it to your registry, and create a Daytona Linux VM snapshot from the
resulting image digest.
The **Daytona Eval Image** workflow offers a manual `computer-desktop` target:
it publishes AMD64 to an immutable `computer-desktop-<commit>` tag without
changing the existing eval image's `dev` tag. Its run summary records the digest.
[Daytona’s snapshot requirements](https://www.daytona.io/docs/en/snapshots/)
require an AMD64 image and an existing image reference for Linux VMs:

```sh
docker build --platform linux/amd64 -f ee/packages/headless-computer/Dockerfile.desktop \
  -t "$COMPUTER_IMAGE" .
docker push "$COMPUTER_IMAGE"
daytona snapshot create workbot-desktop --image "$COMPUTER_IMAGE_DIGEST" \
  --sandbox-class linux-vm --cpu 2 --memory 4 --disk 10
```

Daytona's image-to-VM conversion clears setuid bits. The image includes a root
oneshot unit, ordered before Daytona's command daemon, to restore the packaged
`sudo` and Chromium sandbox helpers on boot. The provider account can invoke only
the fixed desktop bridge through sudo; it cannot run arbitrary administrative commands.
The bridge runs the root-owned guest and startup script installed in the image,
keeps its bearer under `/var/lib/openwork-desktop`, and refuses a mismatched
runner version. A runner update that changes the guest requires a rebuilt snapshot.
Model shell commands run as `openwork-command`, which has no sudo rule and cannot
invoke the desktop bridge or read the browser profile. The provider account keeps
access to shared files; neither desktop bearers nor GUI credentials enter a shell.
The command and GUI users remain unprivileged; Chromium keeps its native sandbox enabled. Desktop startup also
reapplies shared-folder default ACLs, which the image conversion does not retain.
The image builds pinned x11vnc 0.9.17 with XComposite support so Browser view
retains its pixels behind other desktop apps. The matching source archive and
license are included under `/usr/local/share/doc/openwork-x11vnc`.

Configure the existing headless runner (these are operator capabilities, not
organization rollout flags):

```dotenv
HEADLESS_COMPUTER=daytona
HEADLESS_COMPUTER_CLASS=linux-vm
HEADLESS_COMPUTER_DESKTOP=true
HEADLESS_COMPUTER_SNAPSHOT=workbot-desktop
DAYTONA_TARGET=<the snapshot's region>
```

Keep `DAYTONA_API_KEY` in the runner's existing secret configuration and set
`DAYTONA_API_URL=https://app.daytona.io/api`. On celld, these settings must also
be in the `CELLD_RUNNER_VARS` secret of the `celld-production` GitHub environment:
Render service variables alone are not Worker bindings. Deploy with the existing
runner workflow and wait for every node to adopt the bundle. Keep its compatibility
and real-turn checks enabled.

A computer has two identities (`scripts/desktop-identity.mjs`). The image's
covers the files the image installs, including the root-owned bridge; it names
the snapshot. The guest's covers the files esbuild bundles into the guest and
the versions of the packages it bundles. The rest of the lockfile, Mac-only code
and tests change neither. The headless computer build embeds both, and the
compressed guest, in the runner bundle, so celld needs no local package asset
files.

New runner builds reach existing computers without erasing them:

- **Same image, new guest** (most changes): the runner hands the bridge its
  guest, which the bridge checks against the image and its checksum, then
  restarts the guest. The browser, its tabs and the disk stay as they were.
- **Older image that speaks the same protocol** (`DESKTOP_PROTOCOL`): the runner
  keeps using the computer's own desktop and replaces the computer the next
  time it is idle.
- **Older image it can't drive**: the runner replaces the computer as soon as
  no other command or background job is running on it. Until then the person
  sees "Updating your computer" and the model is told to try again shortly
  (`desktop_updating`).

A replacement comes from the current snapshot and carries the browser profile
(signed-in sites, without caches) and `/workspace` over, each up to 100 MB; the
person's Files are copied in again on next use. Computers from before this
existed carry only `/workspace`. An idle replacement happens only when both
carry over. **Rebuild computer** still starts clean, carrying nothing.

### Freestyle instead of Daytona

Freestyle runs the same desktop from a snapshot captured while the desktop is
already up, so a new computer resumes in seconds instead of booting it. Build it
from a checkout whose guest matches the runner you deploy, then point the runner
at the printed slug:

```bash
pnpm --filter @openwork-ee/headless-computer build
FREESTYLE_API_KEY=... pnpm --filter @openwork-ee/headless-computer snapshot:build:freestyle-desktop
```

```dotenv
HEADLESS_COMPUTER=freestyle
HEADLESS_COMPUTER_DESKTOP=true
HEADLESS_COMPUTER_SNAPSHOT=<printed workbot-desktop-freestyle-… slug>
# Optional: keep each conversation's computer until removed (default: delete after KEEP_DAYS unused).
HEADLESS_COMPUTER_PERSISTENT=true
# Optional: publish the viewer under a domain verified on the Freestyle account (default style.dev).
HEADLESS_COMPUTER_DOMAIN=computers.example.com
```

The production deploy (`celld-runner-deploy.yml`) builds the snapshot itself
when the configured slug was built for a different image. A guest-only change
builds nothing: the runner installs its guest into the computers it starts. It
uses the runner's `FREESTYLE_API_KEY`, names the snapshot after the new image,
and bundles the runner with that slug. A later run with the same image finds the
snapshot already built. If the build fails, the deploy stops before the fleet
changes. Building a snapshot also gives the earlier `workbot-desktop-freestyle-…`
snapshots a 14-day deletion window: Freestyle deletes one once no computer has
been created from it for 14 days, so a recent one stays available to roll back
to.
The plain `HEADLESS_COMPUTER_SNAPSHOT` variable in the `celld-production`
GitHub environment overrides the same field in `CELLD_RUNNER_VARS`; set it to a
slug not named by the builder to choose a snapshot by hand, which the deploy
then uses without checking.

Keep `FREESTYLE_API_KEY` in the runner's secrets. Each desktop computer
publishes only its viewer port, at a random host under that domain; the guest's
single-use, origin-bound viewer tickets still gate every connection. Freestyle
pauses a computer with its memory after the runner's idle period, and resumes it
for the next turn. The builder installs the desktop on Freestyle's Ubuntu base,
with Chromium for Testing in place of Debian's package and patched Node 24.x
(24.22.1 or newer). A runtime change is an image change: deploying it builds a
new snapshot, and existing computers move to it as described above.

### Through a sandbox gateway

The `sandboxGateway` feature flag moves one organization's Workbot computers onto
the runner's sandbox gateway (Differently) while every other organization keeps
the runner's own Freestyle or Daytona account. The gateway holds those provider
keys and picks the provider by its own policies. Configure it on the runner with
its own settings, apart from `HEADLESS_COMPUTER`:

```dotenv
SANDBOX_GATEWAY=differently
SANDBOX_GATEWAY_URL=https://differently.example.com
SANDBOX_GATEWAY_API_KEY=<project-scoped key>
SANDBOX_GATEWAY_TEMPLATE=<template mapped to the desktop image>
```

With the flag on and the gateway down or unable to start a computer, new
computers are made on the runner's own provider, and the runner logs the change.
A computer already on the gateway stays there, and the gateway's own refusals
(quotas, placement policy) are errors, never a reason to go around it.
Organizations without the flag never use the gateway. See the runner's
[sandbox gateway notes](../../ee/apps/headless-runner/README.md#sandbox-gateway).

## Transport and rollout

The Workbot server checks signed-in membership and the organization flags before
issuing a viewer connection. Daytona signs access to port 6080 for 75 seconds.
The guest additionally consumes an origin-bound, one-use ticket, valid for 15
seconds, and closes each WebSocket after 60 seconds. Reconnection checks
membership and flags again. An already-open connection can outlive a flag change
for the 30-second membership cache plus its remaining 60-second connection.
Provider API keys and sandbox-wide preview tokens never enter the page.

Each viewer gets a private stdio connection to its own x11vnc process, with no
shared VNC TCP listener. Watching uses x11vnc's server-side read-only
mode; noVNC's `viewOnly` setting also disables accidental input. Both manual
streams and structured tools operate the same broad desktop. Browser processes
run as an unprivileged account with Chromium's sandbox and a protected X cookie.
Workbot's model and connected-app tokens are not passed to the desktop.
The browser can reach public websites; its desktop egress guard blocks private
and loopback destinations, with DNS exceptions restricted to the configured
resolvers on port 53. Native apps cannot open network connections. The command
account cannot reach the reserved desktop control ports; authenticated viewer
and helper transports remain separate. The desktop image uses native nftables
UID rules on microVM kernels without `xt_owner`, and startup fails if rule
installation fails. Hosts without nftables retain the existing iptables guard.
Organization website allowlists still need enforcement at the VM network boundary.

## Teach browser tasks

With `browserDemonstrations` enabled, members can demonstrate a browser task,
explain it in chat, select fields to collect, and save a private reusable skill.
See [Teach Workbot browser tasks](browser-demonstrations.md) for the flow,
recording boundaries, and desktop snapshot requirements.

## Useful applications

The desktop image includes a practical set of applications on the same display:

| Application | Useful work |
| --- | --- |
| Blender | 3D modeling, animation and CPU rendering |
| LibreOffice Writer, Calc, Impress and Draw | Documents, spreadsheets, presentations, diagrams and PDF edits |
| GIMP and Inkscape | Photo editing, illustrations, SVG and graphics |
| Evince and VLC | Inspect PDF, audio and video outputs |
| Thunar, Mousepad and Xterm | Files, text/code editing and Linux commands |

The existing command tools also include Python data/document libraries, FFmpeg,
ImageMagick, OCR and document conversion. The non-desktop headless image keeps
its lighter LibreOffice packages; GUI apps are installed only in the desktop image.

**Applications** in the bottom taskbar, **Super+Space**, or a desktop right-click
opens the app menu. The taskbar switches between open windows. Uploaded files
are in `/workspace/files`; save deliverables in `/workspace/out`. The desktop's
Uploads, Outputs and Downloads shortcuts point to these shared folders. Both
the command user and GUI user can save outputs through a dedicated shared group
and default directory ACLs. Homes and files elsewhere use private permissions;
the GUI account is not a member of the command user's group. App profiles live
in `/home/openwork-app` and survive VM pause/resume. This account cannot read
the Chromium profile or open network connections; use shared uploads and outputs
to exchange files with native apps. Browser downloads also use the shared outputs.

Workbot's `desktop` tool exposes `computer_apps {}` to discover app availability,
package versions, supported formats, paths and environment guidance, and
`computer_launch {app:"blender"}` to launch an app. Pass an optional absolute
`path` to open a file. A launch receipt is followed by a fresh desktop observation;
it does not prove the application is ready or the file saved. Older snapshots
report missing apps honestly and need an operator rebuild to add them. Existing
computers are never replaced automatically. Launches use the same input rail
and takeover pause as browser and native actions, with no extra consent screen.

### Scripting apps instead of clicking

`computer_app_script {app, ...}` drives an app through its own scripting
interface, so a scene edit or spreadsheet change is one call instead of dozens
of screenshot-and-click rounds. The GUI stays for looking at the result.

| App | Interface | What it does |
| --- | --- | --- |
| Blender | `bpy` in the open session, or `blender --background` | Runs Python, returns objects, materials and camera, optionally renders (`viewport` or `final`) |
| Calc, Writer, Impress, Draw | UNO over a named pipe | Reads and writes cell ranges, inserts text, exports PDF, and reports what changed |
| GIMP | Script-Fu batch mode | Converts, resizes and rotates images |
| Inkscape | `inkscape --actions` (`transform`) | Exports, resizes and transforms drawings |

Launching Blender loads a small bridge (`--python`) that listens on a Unix
socket for that process in the desktop user's home; with several Blender
instances, scripting selects the focused Blender window and refuses an ambiguous
target. LibreOffice launches with a named UNO pipe.
Both are sockets, not loopback ports, because the desktop egress guard refuses
loopback for that user. Each Blender script is one undo step, so the person can
press Ctrl+Z. LibreOffice edits stay unsaved in the open window unless the call
passes `save: true`; a file with no open window is edited headlessly and saved.
Cell strings are always stored as text, so content copied from a page or file
is never evaluated. Formulas are explicit `{formula}` cells and are refused if
they fetch or link outside the workbook (`WEBSERVICE`, `DDE`, `HYPERLINK`,
`INDIRECT`, `IMAGE` or external references), including URLs constructed from cell
contents. This also protects saved files opened outside the desktop's network isolation.

Scripts run as `openwork-app`, separated from the browser and command accounts.
The private browser home is inaccessible and IPv4/IPv6 egress is denied, including
DNS and loopback; app bridges use Unix sockets. The same `computerUse` and
`remoteComputers` rollout applies, with no new consent prompt. They use the shared
input rail. Stop requests cancellation and takeover waits for its acknowledgement.
Blender checks at Python lines and between render/save phases; a native render
may finish before cancellation is acknowledged, and no later save begins. Other
lanes end their child process. A stopped, timed-out or
interrupted script reports that its outcome is uncertain and is never retried.
Launch receipts for scriptable apps include a one-line hint with the scripting
route and a few shortcuts.

## MicroVM lifecycle and cost

Daytona's `linux-vm` class is its hypervisor-backed microVM, also used by the
upstream Daytona worlds. Desktop mode requires that class and verifies the
configured snapshot with Daytona before creating or adopting a computer.
It never silently falls back to a container or an unprepared image. Snapshot
resources determine the computer's size; a warm pool is not required.

One stable computer is reused per conversation, including after runner restarts.
The default idle period is five minutes (`HEADLESS_COMPUTER_PAUSE_SECONDS=300`).
The runner pauses after work, and Daytona receives an independent auto-pause
backstop one minute later, with auto-stop disabled. The grace period lets the
runner check background jobs before the provider deadline. This keeps unsaved apps and processes in memory
even if the runner goes away. Prewarming also releases its idle timer. A new
operation waits for an in-progress local idle pause, then resumes the same VM.

`HEADLESS_COMPUTER_KEEP_DAYS` defaults to 14 days without work. MicroVMs receive
a renewable provider TTL so paused disks can eventually expire too; Daytona's
auto-delete setting alone applies to stopped computers. Commands, file access,
and viewer access renew the lease, at most once a minute. Inventory and idle
maintenance probes do not renew it. Export deliverables to kept Files before
retention expires. `HEADLESS_COMPUTER_PERSISTENT=true` disables that deletion on
both providers: computers stay paused with their memory until removed.

The shared Daytona provider exposes `blocks.snapshots` for explicit hot
checkpoints using `{includeMemory:true}`, matching upstream's world API. A
checkpoint returns only after it is active; launching from it restores running
processes without rebuilding software. Routine pause/resume uses the original
VM. Checkpoints consume separate storage until their owner deletes them, even
after VM deletion. The adapter waits for VM deletion to finish and resolves a
snapshot's provider ID for deletion.

For the managed Web runtime, set `DAYTONA_SANDBOX_CLASS=linux-vm` and a prepared
`DAYTONA_SNAPSHOT`. `DAYTONA_SANDBOX_AUTO_PAUSE_INTERVAL` defaults to five minutes.
On that class, auto-stop and container-only auto-archive are omitted. A positive
`DAYTONA_SANDBOX_AUTO_DELETE_INTERVAL` also sets the renewable idle-retention
lease; its default remains disabled for durable Web instances.
Fresh authenticated worker activity renews Daytona's idle timer because preview
traffic alone does not count as provider activity. An inactive health heartbeat
cannot keep compute alive, and a late heartbeat never resumes a paused VM.

Paused microVMs stop CPU/RAM billing; retained disk and checkpoint storage remain
billable. See [Daytona billing](https://www.daytona.io/docs/en/billing/).

Blender uses Mesa software OpenGL; Cycles renders run on CPU. This image does
not supply a GPU. Its initial scene uses CPU Cycles with denoising off so builds
without OpenImageDenoiser can render. Start with small scenes and previews. For Blender and multiple
large apps, size the snapshot explicitly (for example 4 CPUs, 8 GiB memory,
32 GiB disk); the smaller example above is intended for light desktop work.
Use the snapshot's pinned image digest to reproduce its package versions.

This follows the published [OpenAI dot computer model](https://learn.chatgpt.com/docs/dots/computers-and-apps):
a persistent cloud computer with its own software, files and browser sessions,
with explicit takeover and return of control. OpenAI's public
[Linux environment recipe](https://developers.openai.com/api/docs/guides/tools-computer-use-integration#prepare-an-environment)
also uses an ordinary user, a shared X11 display, screenshots and browser viewing.
OpenWork retains its authenticated session transport and credential isolation.
The application selection here is OpenWork's; OpenAI does not document its
dot's installed package list on those pages.

Focused checks:

For a private cloud test deployment, launch the maintained Workbot world with a
published snapshot. It enables the existing flags only for its seeded test org,
never gives the previewed checkout your Daytona key: the runner host gets a key
limited to sandboxes and their snapshots that expires with the preview and is
revoked at teardown (your key needs `manage:api_keys` to create it). Because the
runner holds that key, the source must already be on `dev`; to preview another
commit, review it and set `OPENWORK_PREVIEW_TRUSTED_SHA=<that commit>`. The world
removes its computer VMs during teardown. The world retains its deterministic test model; this tests
desktop control without implying real model inference. Hosting sandboxes have a
provider TTL; conversation computers have one-day idle retention as a crash backstop.

```sh
pnpm world up preview-workbot --place daytona --stage computer-desktop --detach \
  --timeout 1200000 --source sha:<pushed-commit> -- \
  --computer-snapshot <published-linux-vm-snapshot>
pnpm world outputs preview-workbot --stage computer-desktop --reveal
pnpm world down preview-workbot --stage computer-desktop
```

```sh
pnpm evals:e2e workbot-computer --local
pnpm --filter @openwork-ee/workbot exec tsx --conditions=development --test scripts/computer.test.ts
pnpm --dir ee/packages/headless-computer exec tsx --conditions=development \
  scripts/prove-desktop-vnc.ts <dedicated-test-vm>
DAYTONA_API_KEY=… pnpm --dir ee/packages/headless-computer exec tsx --conditions=development \
  scripts/prove-daytona-lifecycle.ts
```

The Workbot journey proves rollout, navigation and recovery through the real
signed-in application. The CLI diagnostic operates a dedicated prepared VM and
checks actual signed RFB streams; it does not provision or delete a sandbox.
The lifecycle diagnostic creates two small microVMs and one private hot
checkpoint, verifies memory continuity, automatic pause and runner restart, and
deletes its resources in `finally`. Its test computers have a 30-minute provider
TTL as a crash backstop. Set `DAYTONA_TARGET` and `HEADLESS_COMPUTER_SNAPSHOT` to
test another compatible region/snapshot; it never provisions a warm pool.

For image acceptance, copy `ee/packages/headless-computer/scripts/prove-desktop-apps.mjs`
into a dedicated prepared test guest, start its desktop, then run it as root with
`DISPLAY=:99 XAUTHORITY=/run/openwork-desktop/99/.Xauthority node prove-desktop-apps.mjs --dedicated-guest`.
It checks the installed catalog, launches four GUI apps, saves text through the
editor and renders a small Blender scene on CPU. It then adds a red cube and
renders it twice in a fresh open Blender: first through the GUI alone, replaying
the clicks and keys a computer-use agent needs, then with one
`computer_app_script` call, and prints the act, input and screenshot counts of
each route. It also checks that Stop cancels a running script and exercises the
office, GIMP and Inkscape lanes. It leaves its outputs and screenshots under
`/workspace/out/desktop-apps-proof-…` for inspection.
