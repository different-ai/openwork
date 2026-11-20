#!/usr/bin/env bash
set -euo pipefail
sha=${1:?Usage: package-sha.sh <full-pushed-sha>}
[[ $# == 1 && $sha =~ ^[a-f0-9]{40}$ ]] || { echo 'Expected one full lowercase pushed SHA.' >&2; exit 2; }
export PATH=/usr/local/share/nvm/current/bin:$PATH
export XDG_CACHE_HOME=/tmp/demo-build/cache
export ELECTRON_CACHE=$XDG_CACHE_HOME/electron ELECTRON_BUILDER_CACHE=$XDG_CACHE_HOME/electron-builder
export TARGET=x86_64-unknown-linux-gnu CI=true
sudo apt-get update
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends build-essential python3 pkg-config libsecret-1-dev
mkdir -p /tmp/demo-build/src
cd /tmp/demo-build/src
git init -q
git fetch -q --depth=1 https://github.com/different-ai/openwork.git "$sha"
git checkout -q --detach FETCH_HEAD
test "$(git rev-parse HEAD)" = "$sha"
pnpm install --frozen-lockfile --store-dir /tmp/demo-build/store
pnpm --filter @openwork/desktop package:electron:cloud --linux --x64 --dir --publish never
app=apps/desktop/dist-electron/linux-unpacked
test -x "$app/openwork-cloud"
# Record the digest of a deterministic tar stream of exactly the packaged tree.
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -C "$app" -cf - . | sha256sum | cut -d' ' -f1 > "$HOME/demo/package.sha256"
sudo mv "$app" /opt/openwork-demo
rm -rf /tmp/demo-build
sudo apt-get clean
sudo rm -rf /var/lib/apt/lists/*
