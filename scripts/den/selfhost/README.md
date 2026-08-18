# OpenWork Den self-host bundle

## Requirements

- Linux with systemd (a Proxmox LXC works; Docker is not required)
- A reachable MySQL 8 database
- Root access for the default system install

The archive includes Den API, Den Web, their production dependencies, and Node.js.

See the full operator guide at https://github.com/different-ai/openwork/blob/dev/packages/docs/start-here/linux-native-tarball.mdx

## Install

```sh
tar -xzf openwork-den-linux-x64-VERSION.tar.gz
cd openwork-den-VERSION
sudo ./install.sh
sudoedit /etc/openwork-den/den.env
sudo /opt/openwork-den/current/bin/openwork-den migrate
sudo systemctl enable --now openwork-den.target
```

Den API listens on port 8788 and Den Web on port 3005 by default. Put your TLS reverse proxy in front of them.

## Upgrade

Unpack the new archive and rerun `sudo ./install.sh`. The installer preserves `den.env`, switches the `current` symlink atomically, migrates an active install, and then restarts its services.

## Uninstall

```sh
sudo systemctl disable --now openwork-den.target
sudo rm -f /etc/systemd/system/openwork-den-api.service /etc/systemd/system/openwork-den-web.service /etc/systemd/system/openwork-den.target
sudo systemctl daemon-reload
sudo userdel openwork-den
sudo rm -rf /opt/openwork-den
# Remove /etc/openwork-den separately if its secrets are no longer needed.
```
