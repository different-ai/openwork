#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  ca-certificates curl build-essential autoconf automake libtool pkg-config \
  libvncserver-dev libx11-dev libxext-dev libxrandr-dev libxtst-dev \
  libxdamage-dev libxfixes-dev libxcomposite-dev libssl-dev

# Debian Bookworm's VNC binary omits XComposite. Window streams need it to
# retain Chromium's pixels while Blender or another app covers the browser.
source_dir=/usr/local/share/doc/openwork-x11vnc
mkdir -p "$source_dir"
curl -fsSL https://codeload.github.com/LibVNC/x11vnc/tar.gz/e2b726a8c0464051afda01648072af6835aaa5f7 -o "$source_dir/source.tar.gz"
echo 'c144006a496e6b2fd1aa6993274f5d7a52a7fc9c71ba633765ac669714f02e7c  /usr/local/share/doc/openwork-x11vnc/source.tar.gz' | sha256sum -c -
build_dir=$(mktemp -d /tmp/openwork-x11vnc-build.XXXXXX)
trap 'rm -rf "$build_dir"' EXIT
tar -xzf "$source_dir/source.tar.gz" -C "$build_dir" --strip-components=1
cd "$build_dir"
autoreconf -fi
./configure --with-x --prefix=/usr/local
make -j2
make install
strip /usr/local/bin/x11vnc
ldd /usr/local/bin/x11vnc | grep -q libXcomposite
cp COPYING "$source_dir/COPYING"
