# Computer use adapters

Computer use gives the agent access to a *computer* when its rollout is enabled. A computer is an
adapter: this Mac (the native helper) or a remote machine such as a Freestyle
or Daytona Linux VM. Each chat picks one in the Computer popover and keeps it.

## Layers

| Layer | File | Knows about |
|---|---|---|
| Agent tools (`computer_*`) | `apps/server/src/opencode-plugins/openwork-computer-use.ts` | Nothing about computers; forwards to the desktop |
| Broker | `apps/desktop/electron/computer-control.mjs` | Rollout-controlled access, one session at a time, handoff, receipts, post-action observations, the in-chat request |
| Adapter contract | `ComputerAdapter` in the broker | `id`, `label`, `placement` (`local`/`remote`), `readiness()`, optional `setup()`, `connect()` returning a transport for the seven native tools plus `openwork/ui` notifications |
| This Mac | `computer-local.mjs` + `packages/computer-use` | macOS permissions, the Swift helper |
| Remote runtime | `computer-remote.mjs` | Turns a small driver into the full contract: sessions, automatic window selection, observation ids, at-most-once receipts, batched actions, zoom, take over/continue, watch frames |
| Linux driver | `computer-x11-driver.mjs` | xdotool and ImageMagick over two VM primitives: run a command, read a file |
| Provider bindings | `computer-targets.mjs` | How to reach a VM through `@openwork/sandbox` (`blocks.run`, `blocks.files`) |

The broker never changes for a new computer. A new kind of machine needs a
driver (`windows`, `screen`, `focus`, `screenshot`, `input`); a new provider for
a Linux VM needs only a machine binding (`run`, `read`).

## Feature flags

Both are registry features (`packages/features/src/registry.ts`), off by default
and read by the desktop from Den like every other feature:

- `computerUse`: the Computer button, the tools and the broker. Turning it off
  ends any running session.
- `remoteComputers`: VMs in the computer list. Off, VMs are hidden, a chat that
  chose a VM uses this computer, and a VM session ends at once; each chat's
  saved choice returns when the feature is back on. Requires `computerUse`
  and sign-in to an organization. Electron verifies both resolved features with
  Den through the local policy service; renderer booleans cannot grant VM access.

Environment variables below only say *which* VM to use, never whether the
feature is on.

## Point computer use at a VM

Start the desktop with these in its environment:

```sh
OPENWORK_COMPUTER_FREESTYLE_VM=<vm id> FREESTYLE_API_KEY=<key>
OPENWORK_COMPUTER_DAYTONA_SANDBOX=<sandbox id> DAYTONA_API_KEY=<key> DAYTONA_API_URL=<url>
OPENWORK_COMPUTER_DISPLAY=:99   # the VM's X display, default :99
```

The VM must be running with an X display that its default user can reach,
plus `xdotool`, ImageMagick and Python 3 (`apt-get install -y xdotool imagemagick python3`).
For a bare VM, install `xvfb`, `xauth` and `openssl`, then start a display with
an authentication cookie owned by the account that runs the apps and provider
commands:

```sh
umask 077
touch "$HOME/.Xauthority"
chmod 600 "$HOME/.Xauthority"
xauth -f "$HOME/.Xauthority" add :99 . "$(openssl rand -hex 16)"
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -auth "$HOME/.Xauthority"
```

Run the desktop apps and remote commands as that same account, with access to
its authority file. Display access control stays enabled and TCP listening is
disabled. Existing Freestyle worlds use their configured display on `:99`.
Readiness reports what is missing. The Computer popover lists configured VMs beside this Mac. Ask for the task; app windows are selected automatically without chat or window consent prompts. On Linux and Windows, an available VM is the default target when no computer was previously chosen.

## Differences from this Mac

- No accessibility tree: observations return the image only, and the agent acts
  with coordinates (`press`/`set_value` are refused; `assist` mode is not offered).
- Keyboard: `command` is sent as control and `option` as alt, so Mac-style
  shortcuts work; discovery says so.
- No macOS permissions or presence overlay; the floating Computer view shows the
  VM's window, and Take over pauses the agent there.
- The rollout grants access to the configured VM. Input uses normal XTest mouse and keyboard events, so ordinary Linux apps receive clicks and text. App sessions focus the selected window and translate image coordinates to its position; desktop sessions use the whole screen. This is computer access, not an X11 window security boundary.
- Input dispatch checks takeover between actions and between short text chunks.
- One session at a time across all computers, as on this Mac.

## Not yet

- Credentials come from the desktop's environment, for development and
  self-hosted use. A product path should broker VM access through Den with the
  member's policy instead of a key on the desktop.
- No provisioning: the adapter drives an existing VM and never creates, wakes or
  pays for one.
- Person input on the VM (a VNC view in the Computer view) and Windows VMs.
