#!/bin/sh
# Entrypoint of Workbot's Fast Sandbox template. It runs as root while the
# template is built, before its memory snapshot, so what it starts is already
# running in every computer restored from the template.
# Fast Sandbox's guest init mounts /run world-writable, which the desktop's
# start script refuses.
chmod 0755 /run
# The guest is named "sandbox" with no hosts entry, so sudo cannot resolve it.
grep -q '[[:space:]]sandbox$' /etc/hosts || echo '127.0.1.1 sandbox' >> /etc/hosts
# A restored snapshot keeps the time it was written; chrony steps it from NTP.
mkdir -p /run/chrony /var/lib/chrony
chronyd -f /etc/chrony/fast-sandbox.conf || echo "chronyd did not start" >&2
# Start the desktop exactly as the runner does, so the snapshot captures it
# running, as the Freestyle desktop snapshot does.
desktop=/usr/local/share/openwork-desktop
/usr/local/sbin/openwork-desktop-bridge start "$(cat "$desktop/image.version")" "$(cat "$desktop/guest.version")" \
  > /var/log/fast-sandbox-desktop-start.log 2>&1 &
exec "$@"
