# Arch Linux AMD64 package

Use this directory to build and install the AMD64 OpenWork package locally on Arch Linux without Docker.

## What this packaging does

- Targets `x86_64` Arch Linux.
- Downloads the published GitHub release asset `openwork-desktop-linux-amd64.deb`.
- Repackages the `.deb` contents into an Arch package with `makepkg`.
- Removes the bundled `/usr/bin/opencode` file so the package does not conflict with `opencode-bin`.

## Prerequisites

- Arch Linux on `x86_64`
- `base-devel`
- `bsdtar` / `libarchive`
- `curl`

Install the packaging prerequisites once:

```bash
sudo pacman -S --needed base-devel curl libarchive
```

## Build and install the current packaged version

From the repo root:

```bash
cd packaging/aur
makepkg -si
```

That will:

1. download the AMD64 `.deb` pinned in `PKGBUILD`
2. build an Arch package such as `openwork-<version>-1-x86_64.pkg.tar.zst`
3. install it locally with `pacman`

After install, `openwork` is available as the desktop launcher. If you also want the standalone OpenCode CLI, install `opencode-bin` separately.

## OpenCode CLI conflict note

Recent `.deb` builds include `/usr/bin/opencode`, but the AUR package intentionally strips that file during repackaging.

That keeps OpenWork compatible with systems that already install the OpenCode CLI from `opencode-bin`, which should remain the owner of the global `opencode` command.

## Update the package to a newer release

If the GitHub release version changed, refresh the packaging metadata first:

```bash
scripts/aur/update-aur.sh v0.11.162
```

Then rebuild:

```bash
cd packaging/aur
makepkg -si
```

## Build without installing

```bash
cd packaging/aur
makepkg -s
```

This leaves the built package in `packaging/aur/` so you can install it later with:

```bash
sudo pacman -U openwork-<version>-1-x86_64.pkg.tar.zst
```

## Verify the installed app

```bash
openwork
```

If you want to confirm the package contents first:

```bash
pacman -Ql openwork
```
