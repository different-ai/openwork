# Restart to update before the download

Feature key: `desktopUpdateDownloadWindow` · deployments: cloud and self-hosted · default off · author: reachjalil

## What changes

Without the feature, the desktop title bar shows **Restart to update** only
once an update has been downloaded. If a newer build shipped after that
download, clicking it fetches the newer build first, and the person waits with
no sign that anything is happening.

With the feature on:

- **Restart to update** shows as soon as an update is found (`available`) or
  while it downloads, not only once it is staged.
- After the existing restart confirmation, a small window shows the download
  with its progress ("Downloading update", bytes and percent), then the app
  restarts on its own once the build is staged.
- When the staged build is current, the window shows "Getting the update
  ready…" briefly before the restart.
- **Keep working** closes the window and calls the restart off. The download
  keeps going, and the update installs on the next restart or quit.
- A failed download or install closes the window; the updater's usual
  notification explains the failure.

Settings › Updates is unchanged.

## Turning it off

The title bar goes back to showing the button only when an update is ready,
with the old restart behaviour. Nothing is stored; an open window simply
stops being offered.

## How to try it

Turn it on for your organization in `/admin`, run a desktop build older than
the latest release with automatic download off, and click **Restart to
update** in the title bar.
