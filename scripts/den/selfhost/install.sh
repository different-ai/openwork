#!/bin/sh
set -eu

PREFIX=/opt/openwork-den
CONFIG_DIR=/etc/openwork-den
SYSTEMD_DIR=/etc/systemd/system
NO_SYSTEMD=0
NO_USER=0

usage() {
  echo "Usage: ./install.sh [--prefix PATH] [--config-dir PATH] [--systemd-dir PATH] [--no-systemd] [--no-user]"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix|--config-dir|--systemd-dir)
      [ "$#" -ge 2 ] || { echo "Missing value for $1" >&2; exit 2; }
      flag=$1
      value=$2
      shift 2
      case "$flag" in
        --prefix) PREFIX=$value ;;
        --config-dir) CONFIG_DIR=$value ;;
        --systemd-dir) SYSTEMD_DIR=$value ;;
      esac
      ;;
    --no-systemd) NO_SYSTEMD=1; shift ;;
    --no-user) NO_USER=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

BUNDLE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
VERSION=$(cat "$BUNDLE_DIR/VERSION")
case "$VERSION" in
  ""|*[!A-Za-z0-9._+-]*) echo "Invalid bundle VERSION: $VERSION" >&2; exit 1 ;;
esac

if [ "$NO_USER" -eq 0 ] && ! id -u openwork-den >/dev/null 2>&1; then
  NOLOGIN=/usr/sbin/nologin
  [ -x "$NOLOGIN" ] || NOLOGIN=/sbin/nologin
  useradd --system --user-group --home-dir "$PREFIX" --shell "$NOLOGIN" openwork-den
fi

install -d -m 0755 "$PREFIX/versions" "$CONFIG_DIR" "$SYSTEMD_DIR"
DESTINATION="$PREFIX/versions/$VERSION"
if [ ! -d "$DESTINATION" ]; then
  STAGING="$PREFIX/versions/.$VERSION.tmp.$$"
  rm -rf "$STAGING"
  install -d -m 0755 "$STAGING"
  cp -R "$BUNDLE_DIR/." "$STAGING/"
  mv "$STAGING" "$DESTINATION"
fi

printf '%s\n' "$CONFIG_DIR" > "$PREFIX/config-dir.tmp.$$"
mv -f "$PREFIX/config-dir.tmp.$$" "$PREFIX/config-dir"

if [ ! -e "$CONFIG_DIR/den.env" ]; then
  install -m 0600 "$BUNDLE_DIR/share/den.env.example" "$CONFIG_DIR/den.env"
fi
if [ "$NO_USER" -eq 0 ]; then
  chown root:openwork-den "$CONFIG_DIR/den.env"
  chmod 0640 "$CONFIG_DIR/den.env"
else
  chmod 0600 "$CONFIG_DIR/den.env"
fi

escape_sed() {
  printf '%s' "$1" | sed 's/[|&\\]/\\&/g'
}

PREFIX_SED=$(escape_sed "$PREFIX")
CONFIG_DIR_SED=$(escape_sed "$CONFIG_DIR")
for unit in openwork-den-api.service openwork-den-web.service openwork-den.target; do
  sed -e "s|@PREFIX@|$PREFIX_SED|g" -e "s|@CONFIG_DIR@|$CONFIG_DIR_SED|g" \
    "$BUNDLE_DIR/share/systemd/$unit" > "$SYSTEMD_DIR/.$unit.tmp.$$"
  chmod 0644 "$SYSTEMD_DIR/.$unit.tmp.$$"
  mv -f "$SYSTEMD_DIR/.$unit.tmp.$$" "$SYSTEMD_DIR/$unit"
done

LINK="$PREFIX/.current.$$"
rm -f "$LINK"
ln -s "versions/$VERSION" "$LINK"
"$DESTINATION/bin/node" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' \
  "$LINK" "$PREFIX/current"

if [ "$NO_SYSTEMD" -eq 0 ]; then
  systemctl daemon-reload
  if systemctl is-active --quiet openwork-den-api.service || systemctl is-active --quiet openwork-den-web.service; then
    "$PREFIX/current/bin/openwork-den" migrate
    systemctl restart openwork-den-api.service openwork-den-web.service
  fi
fi

echo "OpenWork Den $VERSION installed in $DESTINATION"
echo "Next steps:"
echo "  1. Edit $CONFIG_DIR/den.env"
echo "  2. Run $PREFIX/current/bin/openwork-den migrate"
if [ "$NO_SYSTEMD" -eq 0 ]; then
  echo "  3. Run systemctl enable --now openwork-den.target"
else
  echo "  3. Start the installed openwork-den-api.service and openwork-den-web.service units"
fi
