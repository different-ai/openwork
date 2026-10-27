#!/bin/sh
set -eu
state="$1/cloud-desktop"
display="$2"
case "$display" in :[0-9]|:[0-9][0-9]|:[0-9][0-9][0-9]) ;; *) echo "Invalid cloud display" >&2; exit 1 ;; esac
command -v chromium >/dev/null
command -v Xvfb >/dev/null
# OCI-to-VM conversion does not preserve default ACLs. Reapply the desktop
# image's shared-folder policy before launching apps or accepting uploads.
if [ -f /usr/local/share/openwork-desktop/configure-files.sh ]; then
  bash /usr/local/share/openwork-desktop/configure-files.sh
fi
runtime="/run/openwork-desktop/${display#:}"
# Root's authority and logs never live in the browser-writable profile state.
# Hold directory inodes while setting ownership; never recurse through that state.
python3 - "$1" "$runtime" <<'PY'
import os
import pwd
import stat
import sys

def prepare_state(base, runtime, uid, gid):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    def trusted(fd):
        info = os.fstat(fd)
        if info.st_uid != os.geteuid() or info.st_mode & 0o022:
            raise PermissionError('Desktop root state must be owned by its trusted host and not writable by other accounts')
    def directory(parent, name, mode, owner, group):
        try: os.mkdir(name, mode=mode, dir_fd=parent)
        except FileExistsError: pass
        fd = os.open(name, flags, dir_fd=parent)
        try:
            if owner == os.geteuid(): trusted(fd)
            os.fchown(fd, owner, group)
            os.fchmod(fd, mode)
        except BaseException:
            os.close(fd)
            raise
        return fd
    parent = os.open(base, flags)
    try:
        trusted(parent)
        profile = directory(parent, 'cloud-desktop', 0o700, uid, gid)
        os.close(profile)
    finally: os.close(parent)
    # /run is root-owned. Reject pre-existing symlinks and writable directories
    # before any root redirection, xauth lock, or ownership change occurs there.
    parent_path, name = os.path.split(runtime)
    grandparent_path, parent_name = os.path.split(parent_path)
    root = os.open(grandparent_path, flags)
    try:
        trusted(root)
        parent = directory(root, parent_name, 0o755, os.geteuid(), os.getegid())
        try: folder = directory(parent, name, 0o710, os.geteuid(), gid)
        finally: os.close(parent)
    finally: os.close(root)
    try:
        for name in ('.Xauthority', 'display.log', 'window-manager.log', 'taskbar.log', 'browser.log'):
            fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=folder)
            try:
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1 or info.st_mode & 0o022:
                    raise PermissionError('Desktop runtime files must be private regular files')
                os.fchown(fd, os.geteuid(), gid)
                os.fchmod(fd, 0o640 if name == '.Xauthority' else 0o600)
            finally: os.close(fd)
    finally: os.close(folder)

browser = pwd.getpwnam('openwork-browser')
prepare_state(sys.argv[1], sys.argv[2], browser.pw_uid, browser.pw_gid)
PY
export DISPLAY="$display" XAUTHORITY="$runtime/.Xauthority"
as_browser() {
  # The desktop must not inherit the worker's host, model or activity tokens.
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/home/openwork-browser \
    USER=openwork-browser LOGNAME=openwork-browser LANG=C.UTF-8 \
    DISPLAY="$display" XAUTHORITY="$XAUTHORITY" LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe runuser -u openwork-browser -- "$@"
}
as_app() {
  env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/home/openwork-app \
    USER=openwork-app LOGNAME=openwork-app LANG=C.UTF-8 \
    DISPLAY="$display" XAUTHORITY=/home/openwork-app/.Xauthority LIBGL_ALWAYS_SOFTWARE=1 GALLIUM_DRIVER=llvmpipe runuser -u openwork-app -- "$@"
}
# Agent-driven pages cannot reach private networks. Native apps cannot open
# network connections at all; the browser's CDP and VNC replies still work.
# Native nftables UID matches also work on microVM kernels that omit xt_owner.
# Use one atomic transaction and reserve control ports for trusted transports.
guard_desktop_nft() {
  browser_uid=$(id -u openwork-browser)
  command_uid=""
  app_uid=""
  if id openwork-command >/dev/null 2>&1; then command_uid=$(id -u openwork-command); fi
  if id openwork-app >/dev/null 2>&1; then app_uid=$(id -u openwork-app); fi
  {
    if nft list table inet openwork_desktop >/dev/null 2>&1; then
      printf '%s\n' 'delete table inet openwork_desktop'
    fi
    printf '%s\n' 'add table inet openwork_desktop'
    printf '%s\n' 'add chain inet openwork_desktop output { type filter hook output priority 0; policy accept; }'
    if [ -n "$command_uid" ]; then
      printf 'add rule inet openwork_desktop output meta skuid %s tcp dport { 5900-5903, 6080, 9222 } reject\n' "$command_uid"
    fi
    if [ -n "$app_uid" ]; then
      printf 'add rule inet openwork_desktop output meta skuid %s reject\n' "$app_uid"
    fi
    printf 'add rule inet openwork_desktop output meta skuid %s ct state established,related accept\n' "$browser_uid"
    for nameserver in $(awk '/^nameserver/ { print $2 }' /etc/resolv.conf); do
      nameserver=${nameserver%%%*}
      family=ip
      case "$nameserver" in *:*) family=ip6 ;; esac
      printf 'add rule inet openwork_desktop output meta skuid %s %s daddr %s meta l4proto { tcp, udp } th dport 53 accept\n' "$browser_uid" "$family" "$nameserver"
    done
    printf 'add rule inet openwork_desktop output meta skuid %s ip daddr { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16 } reject\n' "$browser_uid"
    printf 'add rule inet openwork_desktop output meta skuid %s ip6 daddr { ::/96, ::ffff:0:0/96, 64:ff9b::/96, 64:ff9b:1::/48, fc00::/7, fe80::/10 } reject\n' "$browser_uid"
  } | nft -f -
}

guard_desktop_egress() {
  if command -v nft >/dev/null 2>&1; then
    guard_desktop_nft
    return
  fi
  uid=$(id -u openwork-browser)
  tools=iptables
  if command -v ip6tables >/dev/null && ip6tables -w -S OUTPUT >/dev/null 2>&1; then tools="iptables ip6tables"; fi
  if [ -e /proc/net/if_inet6 ]; then
    case " $tools " in *" ip6tables "*) ;; *) echo "The desktop network guard needs IPv6 filtering" >&2; exit 1 ;; esac
  fi
  for tool in $tools; do
    # The model's shell has public networking, but cannot bypass the guest's
    # authorization via local CDP, VNC or guest-control listeners.
    if id openwork-command >/dev/null 2>&1; then
      command_uid=$(id -u openwork-command)
      "$tool" -w -C OUTPUT -m owner --uid-owner "$command_uid" -m addrtype --dst-type LOCAL -p tcp -m multiport --dports 5900:5903,6080,9222 -j REJECT 2>/dev/null \
        || "$tool" -w -I OUTPUT 1 -m owner --uid-owner "$command_uid" -m addrtype --dst-type LOCAL -p tcp -m multiport --dports 5900:5903,6080,9222 -j REJECT
    fi
    # Native app code (including Blender Python and visible terminals) has no
    # network access. Its Unix-domain app bridges and X display still work.
    if id openwork-app >/dev/null 2>&1; then
      app_uid=$(id -u openwork-app)
      "$tool" -w -C OUTPUT -m owner --uid-owner "$app_uid" -j REJECT 2>/dev/null \
        || "$tool" -w -I OUTPUT 1 -m owner --uid-owner "$app_uid" -j REJECT
    fi
    "$tool" -w -N OPENWORK_DESKTOP_EGRESS 2>/dev/null || "$tool" -w -F OPENWORK_DESKTOP_EGRESS
    "$tool" -w -C OUTPUT -m owner --uid-owner "$uid" -j OPENWORK_DESKTOP_EGRESS 2>/dev/null \
      || "$tool" -w -I OUTPUT 1 -m owner --uid-owner "$uid" -j OPENWORK_DESKTOP_EGRESS
    "$tool" -w -A OPENWORK_DESKTOP_EGRESS -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
  done
  for nameserver in $(awk '/^nameserver/ { print $2 }' /etc/resolv.conf); do
    nameserver=${nameserver%%%*}
    case "$nameserver" in *:*) tool=ip6tables ;; *) tool=iptables ;; esac
    case " $tools " in *" $tool "*) ;; *) continue ;; esac
    for protocol in udp tcp; do "$tool" -w -A OPENWORK_DESKTOP_EGRESS -d "$nameserver" -p "$protocol" --dport 53 -j RETURN; done
  done
  for range in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16; do
    iptables -w -A OPENWORK_DESKTOP_EGRESS -d "$range" -j REJECT
  done
  case " $tools " in *" ip6tables "*)
    # Match the browser policy, including IPv4-compatible/mapped and NAT64.
    for range in ::/96 ::ffff:0:0/96 64:ff9b::/96 64:ff9b:1::/48 fc00::/7 fe80::/10; do ip6tables -w -A OPENWORK_DESKTOP_EGRESS -d "$range" -j REJECT; done ;;
  esac
}
command -v iptables >/dev/null || { echo "The desktop network guard needs iptables" >&2; exit 1; }
guard_desktop_egress
umask 077
if [ ! -s "$XAUTHORITY" ]; then
  xauth -f "$XAUTHORITY" add "$display" . "$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
fi
chown root:openwork-browser "$XAUTHORITY"
chmod 0640 "$XAUTHORITY"
if ! xdotool getdisplaygeometry >/dev/null 2>&1; then
  as_browser setsid -f Xvfb "$display" -screen 0 1280x800x24 -nolisten tcp -auth "$XAUTHORITY" >"$runtime/display.log" 2>&1 < /dev/null
fi
attempt=0
until xdotool getdisplaygeometry >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 50 ] || { echo "Cloud display did not start" >&2; exit 1; }
  sleep 0.1
done
if id openwork-app >/dev/null 2>&1; then
  # Share display access, never the Chromium profile or browser home. The
  # window manager launches menu/taskbar apps under the same isolated account.
  # A planted destination can only be opened with the app account's own rights.
  cat "$XAUTHORITY" | as_app sh -c 'umask 077; cat > "$HOME/.Xauthority"'
fi
if ! xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id'; then
  if id openwork-app >/dev/null 2>&1; then
    as_app setsid -f openbox >"$runtime/window-manager.log" 2>&1 < /dev/null
  else
    as_browser setsid -f openbox >"$runtime/window-manager.log" 2>&1 < /dev/null
  fi
fi
# A taskbar and Applications menu are installed by the Workbot desktop image.
# Older snapshots still open their browser without claiming extra apps exist.
if command -v tint2 >/dev/null; then
  if id openwork-app >/dev/null 2>&1; then
    if ! pgrep -u openwork-app -x tint2 >/dev/null; then as_app setsid -f tint2 >"$runtime/taskbar.log" 2>&1 < /dev/null; fi
  elif ! pgrep -u openwork-browser -x tint2 >/dev/null; then
    as_browser setsid -f tint2 >"$runtime/taskbar.log" 2>&1 < /dev/null
  fi
fi
if ! curl --fail --silent --max-time 2 http://127.0.0.1:9222/json/version >/dev/null; then
  # The browser runs as an unprivileged user with Chromium's sandbox enabled.
  as_browser setsid -f chromium --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
    --user-data-dir="$state/profile" --window-size=1280,800 --force-device-scale-factor=1 --no-first-run \
    --no-default-browser-check about:blank >"$runtime/browser.log" 2>&1 < /dev/null
fi
attempt=0
until curl --fail --silent --max-time 2 http://127.0.0.1:9222/json/version >/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 50 ] || { echo "Cloud browser did not start" >&2; exit 1; }
  sleep 0.2
done
if [ "${WORKBOT_DESKTOP_VNC:-0}" = 1 ]; then
  command -v x11vnc >/dev/null
  # Chromium opens and closes windows while it starts, and a search that walks the
  # window tree then fails with BadWindow. Retry briefly instead of failing a cold boot.
  window=
  attempt=0
  until [ -n "$window" ]; do
    window=$(xdotool search --onlyvisible --class chromium 2>/dev/null | head -n 1) || window=
    [ -n "$window" ] && break
    attempt=$((attempt + 1))
    [ "$attempt" -lt 25 ] || { echo "The browser window is unavailable" >&2; exit 1; }
    sleep 0.2
  done
  # Root's guest starts one inetd-mode viewer over private stdio. A process
  # binding a local VNC port can never substitute itself for that transport.
  printf '%s\n' "$window" > "$1/browser-window"
fi
