# Low disk space warning (`lowStorageWarning`)

- **Feature key:** `lowStorageWarning`
- **Deployments:** cloud and self-hosted (`everywhere`), off by default
- **Author:** @reachjalil

## What people get

When the computer running OpenWork is almost out of disk space, a message
appears at the top of the window and stays until it is dismissed:

| Free space | Message |
|---|---|
| Under 2 GB | **Your disk is almost full** · "1.4 GB left. Free up space so OpenWork can keep saving your work." |
| Under 200 MB | **Your disk is full** · "120 MB left. OpenWork can't save changes until you free up space." |

The message goes away by itself once there is room again. A dismissed message
is not repeated for a day unless the disk gets fuller (from "almost full" to
"full"), or a save actually fails for lack of space.

Without the feature, people learn the disk is full only when something fails.

## How it works

- The local server answers `GET /disk-space` with the free and total bytes of
  the disk that holds its saved data (`runtime.sqlite` and the files next to
  it), and a level: `ok`, `low` or `critical`. A disk the system cannot
  measure reads as `ok`, never as full.
- The app asks every five minutes, and again right away when any server
  request fails with `insufficient_storage`.
- Only a server on this computer is asked: the desktop app's own, or one
  reached at a loopback address (a self-hosted server opened on the machine
  it runs on). A cloud or remote workspace's disk is not the person's to free
  up, so nothing is shown for it.

## Shipped without the flag

These restore intended behavior and are always on:

- A write that fails because the disk is full (`ENOSPC`, `EDQUOT`, SQLite
  "database or disk is full") answers `507 insufficient_storage` with "Not
  enough disk space. Free up space on the computer running OpenWork, then try
  again." instead of a generic 500.
- Connected-tools maintenance stops retrying on that answer and tells the
  person to free up disk space.
- Error reports for a full disk are grouped into one warning-level issue
  (fingerprint `disk-full`), at most one per ten minutes per app run, tagged
  with `disk.free_mb`.

## Turning it off

The kill switch removes the message, including one that is on screen. The
free-space route stays; nothing is stored on the server.

## What to watch

- The grouped `disk-full` issue in the desktop error project, and its
  `disk.free_mb` tag: values near zero mean disks really were full.
- People seeing the warning with plenty of space would mean the reading is
  wrong for their file system; the limits are in `apps/server/src/disk-space.ts`.
