#!/bin/bash
set -euo pipefail
# Share only conversation uploads and outputs. A GUI application must not gain
# access to the command user's home just because both can edit deliverables.
getent group openwork-workspace >/dev/null || groupadd openwork-workspace
usermod -a -G openwork-workspace ubuntu
usermod -a -G openwork-workspace openwork-browser
usermod -a -G openwork-workspace openwork-app
usermod -a -G openwork-workspace,ubuntu openwork-command
if id -nG openwork-browser | tr ' ' '\n' | grep -qx ubuntu; then
  gpasswd -d openwork-browser ubuntu
fi
chmod 0700 /home/ubuntu /home/openwork-browser /home/openwork-app
chmod 0700 /home/openwork-command
# Provider file operations use ubuntu; model commands use a separate account
# that cannot invoke the privileged bridge or inspect the GUI user's home.
python3 - <<'PY'
import grp
import os
import pwd
import subprocess

def configure_workspace(workspace, uid, gid, shared_gid):
    # The command account can rename entries here. Open directories without
    # following symlinks, then change the held inode rather than its pathname.
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    root = os.open(workspace, flags)
    try:
        os.fchown(root, uid, gid)
        os.fchmod(root, 0o2775)
        for name in ('.jobs', 'files', 'out'):
            try:
                os.mkdir(name, dir_fd=root)
            except FileExistsError:
                pass
            directory = os.open(name, flags, dir_fd=root)
            try:
                os.fchown(directory, uid, gid if name == '.jobs' else shared_gid)
                os.fchmod(directory, 0o2770)
                if name != '.jobs':
                    # Default ACLs follow this same held directory, even if the
                    # command account replaces its original name concurrently.
                    subprocess.run(['setfacl', '-m', 'd:u::rwx,d:g::rwx,d:o::---',
                                    f'/proc/self/fd/{directory}'], pass_fds=(directory,), check=True)
            finally:
                os.close(directory)
    finally:
        os.close(root)

owner = pwd.getpwnam('ubuntu')
configure_workspace('/workspace', owner.pw_uid, owner.pw_gid, grp.getgrnam('openwork-workspace').gr_gid)
PY
