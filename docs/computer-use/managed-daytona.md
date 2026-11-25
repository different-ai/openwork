# Managed cloud computer

For Workbot’s live noVNC Computer tab, see [Workbot computer use](./workbot.md).

OpenWork Web can use a member's managed Daytona Linux VM as its browser and
desktop. The existing Cloud worker remains the owner of the runtime, workspace,
and endpoint. Browser tools drive headed Chromium in that VM; computer tools
drive the same X11 display. Neither tool family asks for chat or window consent.

## Configure the runtime

Build the ordinary OpenWork runtime image using
`ee/apps/den-worker-runtime/Dockerfile.daytona-snapshot`, then build the desktop
layer from its pinned image digest:

```sh
docker build --platform linux/amd64 -f ee/apps/den-worker-runtime/Dockerfile.daytona-desktop \
  --build-arg OPENWORK_RUNTIME_IMAGE=<registry/runtime@sha256:digest> \
  -t <registry/cloud-desktop:version> .
```

Publish that image through the normal operator release process. Create a private
Daytona snapshot from the published image, explicitly selecting `linux-vm`:

```sh
daytona snapshot create <cloud-desktop-version> \
  --image <registry/cloud-desktop:version> --sandbox-class linux-vm \
  --cpu 2 --memory 4 --disk 10
```

Daytona VM snapshots require an existing registry image; its Dockerfile build
path is for container snapshots. Use the region where the VM snapshot is active.
Do not infer its sandbox class from its name.

Configure Den with `DAYTONA_SNAPSHOT=<cloud-desktop-version>` and
`DAYTONA_SANDBOX_CLASS=linux-vm`. Helm exposes the latter as
`config.daytona.sandboxClass`; its default remains `container`. The existing
Cloud image upgrade policy handles workers when they are idle. Use a dedicated
test deployment for the experimental VM image before changing a shared runtime.

In `/admin`, enable **computerUse** and **remoteComputers** for the test
organization. The image/class settings describe the installed runtime, not
feature access. Both flags are checked against the signed-in organization by
the worker on every tool or viewer request and periodically during active work.

## Use it

Open the managed workspace in OpenWork Web. Ask the agent to use the browser
or an app. The Computer button opens its actual desktop image. **Take over**
interrupts both browser and computer work. Click the desktop, use its navigation
keys, or enter text using the field below it. **Continue** gives control back;
old observations and interrupted input are not replayed. **Stop** stops agent
input and leaves control with the person.

This first slice uses a bounded, refreshing PNG view over the existing
authenticated HTTP gateway. It does not yet provide a high-frame-rate VNC stream,
clipboard synchronization, file drag and drop, or remote Web floating modes.

## Pause and resume

Den's existing idle lifecycle selects memory-preserving pause for a verified VM
provider. Resolving the Cloud worker starts it again, renews the endpoint, and
keeps the existing server/browser processes when healthy. A genuinely cold or
unhealthy runtime runs the normal bootstrap. Container workers retain cold
stop/start behavior. Viewing or operating the desktop contributes to worker
activity; an active view does not silently time out while the user is working.
Daytona also receives `autoPauseInterval=5` and `autoStopInterval=0`, independently
of Den's idle loop. Set `DAYTONA_SANDBOX_AUTO_PAUSE_INTERVAL` to adjust that
provider backstop, or `config.daytona.sandboxAutoPauseInterval` in Helm. VM
instances omit container-only auto-archive. A positive
`DAYTONA_SANDBOX_AUTO_DELETE_INTERVAL` enables a renewable inactivity lease for
retained VM disks; durable Web instances keep their existing disabled default.
Paused microVMs release CPU/RAM billing; disks still incur storage charges.
Preview traffic itself does not count as Daytona activity. Fresh, authenticated
worker activity heartbeats renew its idle timer and retention lease while the
person or agent is working. Health heartbeats without activity do not renew
either, and a late heartbeat never wakes a paused computer.

The browser profile lives beneath the worker's runtime data directory and is
included in its existing checkpoint storage. Live memory survives pause/resume;
disk checkpoint recovery relaunches Chromium and cannot promise unsaved memory.
The shared provider also supports explicit hot checkpoints and restored clones
through `blocks.snapshots`, using the same memory-snapshot API as upstream
worlds. A user-facing checkpoint manager remains a later slice. Checkpoint
storage has a separate lifetime from its source computer and needs explicit
owner cleanup. See the [lifecycle diagnostic](./workbot.md#microvm-lifecycle-and-cost).

## Boundaries

The computer is the member's whole VM. Structured website, command, and file
rules do not sandbox arbitrary GUI operations. Its browser profile and downloads
are private to that member's worker. Browser tab handles remain conversation
owned, and one shared input rail prevents concurrent browser/computer actions.
The browser's CDP listener and engine bridge bind only to loopback. The Web
viewer uses the existing member gateway and requires a collaborator token;
viewer tokens cannot read its images or send input. Missing rollout authority
fails closed. Disabling the rollout stops control without deleting the VM or
its data.
